/**
 * LocalCloud emulator tiers (Spanner and BigQuery over REST). SAFETY: every request is checked to be plain http to a loopback host;
 * every created database / dataset carries the run prefix and is dropped in `finally` plus a final sweep. Nothing else is touched.
 */
import type { Validation } from "./validators";

const SPANNER = process.env.CORPUS_SPANNER_URL ?? "http://127.0.0.1:5387";
const BIGQUERY = process.env.CORPUS_BIGQUERY_URL ?? "http://127.0.0.1:5388";
const PROJECT = "local-gcp-project";
const INSTANCE = "local-instance";

export const RUN_ID = Date.now().toString(36).slice(-6);
export const SPANNER_PREFIX = `sscorp_${RUN_ID}_`;
export const BIGQUERY_PREFIX = `ss_corpus_${RUN_ID}_`;

export function assertLoopback(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) {
    throw new Error(`refusing a non-loopback / non-http emulator URL: ${u.protocol}//${u.hostname}`);
  }
}

async function call(method: string, url: string, body?: unknown, timeoutMs = 30000): Promise<{ status: number; json: Record<string, unknown> }> {
  assertLoopback(url);
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: response.status, json };
}

const errorText = (json: Record<string, unknown>): string => {
  const e = json.error as { message?: string } | undefined;
  return (e?.message ?? JSON.stringify(json)).slice(0, 600);
};

/** Splits a script into statements at `;` outside quotes, backticks and comments; comments are dropped. */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote !== "`") { current += script[i + 1] ?? ""; i += 1; } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "-" && script[i + 1] === "-") { while (i < script.length && script[i] !== "\n") i += 1; current += "\n"; continue; }
    if (ch === "/" && script[i + 1] === "*") {
      const end = script.indexOf("*/", i + 2);
      i = end === -1 ? script.length : end + 1;
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; current += ch; continue; }
    if (ch === ";") { if (current.trim()) statements.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export interface EmulatorState { spanner: boolean; bigquery: boolean; reasons: string[] }

export async function probeEmulators(): Promise<EmulatorState> {
  const state: EmulatorState = { spanner: false, bigquery: false, reasons: [] };
  try {
    const r = await call("GET", `${SPANNER}/v1/projects/${PROJECT}/instances/${INSTANCE}`, undefined, 3000);
    state.spanner = r.status === 200;
    if (!state.spanner) state.reasons.push(`spanner emulator answered ${r.status}`);
  } catch (e) { state.reasons.push(`spanner emulator unreachable: ${(e as Error).message}`); }
  try {
    const r = await call("GET", `${BIGQUERY}/bigquery/v2/projects/${PROJECT}/datasets`, undefined, 3000);
    state.bigquery = r.status === 200;
    if (!state.bigquery) state.reasons.push(`bigquery emulator answered ${r.status}`);
  } catch (e) { state.reasons.push(`bigquery emulator unreachable: ${(e as Error).message}`); }
  return state;
}

const dbBase = `${SPANNER}/v1/projects/${PROJECT}/instances/${INSTANCE}/databases`;
export const createdSpanner: string[] = [];
export const createdBigQuery: string[] = [];
let counter = 0;

export async function validateSpanner(ddl: string): Promise<Validation> {
  const tier = "LocalCloud Spanner emulator (CREATE DATABASE + DDL)";
  counter += 1;
  const name = `${SPANNER_PREFIX}${counter}`;
  const statements = splitStatements(ddl);
  try {
    createdSpanner.push(name);
    const created = await call("POST", dbBase, { createStatement: `CREATE DATABASE \`${name}\``, extraStatements: statements });
    if (created.status >= 400) return { ok: false, tier, error: errorText(created.json) };
    let op = created.json;
    for (let i = 0; i < 60 && op.done !== true && typeof op.name === "string"; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      op = (await call("GET", `${SPANNER}/v1/${op.name as string}`)).json;
    }
    if (op.done !== true) return { ok: false, tier, error: "operation did not finish in 15 s" };
    if (op.error) return { ok: false, tier, error: errorText({ error: op.error }) };
    return { ok: true, tier };
  } catch (e) {
    return { ok: false, tier, error: `emulator call failed: ${(e as Error).message}` };
  } finally {
    await dropSpanner(name);
  }
}

async function dropSpanner(name: string): Promise<void> {
  if (!name.startsWith(SPANNER_PREFIX)) return;
  try { await call("DELETE", `${dbBase}/${name}`); } catch { /* the final sweep retries */ }
}

/** Marker prefix of the one failure that is accepted once the PRIMARY KEY constraint is inside the column list (see known-issues.ts). */
export const BQ_PK_OUTSIDE = "table-level PRIMARY KEY written after the column list";

/** `CREATE TABLE t (cols,\n)\nPRIMARY KEY (a) NOT ENFORCED` -> `CREATE TABLE t (cols, PRIMARY KEY (a) NOT ENFORCED)`. */
export function movePrimaryKeyInside(sql: string): string {
  const m = /,?\s*\)\s*(PRIMARY KEY\s*\([^)]*\)\s*NOT ENFORCED)\s*$/i.exec(sql);
  if (!m || m.index === undefined) return sql;
  return `${sql.slice(0, m.index)},\n  ${m[1]}\n)`;
}

/**
 * The only statements this tier sends to the BigQuery emulator: a plain `CREATE [OR REPLACE] TABLE [IF NOT EXISTS] name (column list)
 * [OPTIONS(...)]`, which is all the emitter writes. Anything else is refused before a request is made: other statements (DROP, DELETE,
 * INSERT, ALTER, SELECT, CREATE VIEW / FUNCTION / PROCEDURE / MODEL / EXTERNAL TABLE, ...) and a CREATE TABLE that is not plain DDL
 * (`AS SELECT`, `CLONE`, `COPY`, `LIKE`) as judged on the text outside quoted strings, comments and the parenthesised column list.
 */
export function isAllowedBigQueryStatement(statement: string): boolean {
  const text = statement.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  const head = /^CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.`-]+/i.exec(text);
  if (!head) return false;
  // Outside quotes (' " `) and outside parentheses.
  let outside = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of text.slice(head[0].length)) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth -= 1; continue; }
    if (depth === 0) outside += ch;
  }
  return !/\b(AS|SELECT|CLONE|COPY|LIKE|FUNCTION|PROCEDURE|MODEL|EXTERNAL|VIEW)\b/i.test(outside);
}

export async function validateBigQuery(ddl: string, schemaName: string): Promise<Validation> {
  const tier = "LocalCloud BigQuery emulator (DDL queries)";
  counter += 1;
  const dataset = `${BIGQUERY_PREFIX}${counter}`;
  const base = `${BIGQUERY}/bigquery/v2/projects/${PROJECT}`;
  try {
    createdBigQuery.push(dataset);
    const made = await call("POST", `${base}/datasets`, { datasetReference: { projectId: PROJECT, datasetId: dataset } });
    if (made.status >= 400) return { ok: false, tier, error: `dataset: ${errorText(made.json)}` };
    for (const statement of splitStatements(ddl)) {
      if (/^CREATE SCHEMA/i.test(statement)) continue;
      if (!isAllowedBigQueryStatement(statement)) return { ok: false, tier, error: `refusing to send a statement that is not CREATE/ALTER DDL to the emulator: ${statement.slice(0, 60)}` };
      const sql = statement.replace(new RegExp(`\\b${schemaName.replace(/[^\w]/g, "\\$&")}\\.`, "g"), `${dataset}.`);
      const run = (query: string) => call("POST", `${base}/queries`, { query, useLegacySql: false, defaultDataset: { projectId: PROJECT, datasetId: dataset } });
      const failed = (r: Awaited<ReturnType<typeof run>>): boolean => r.status >= 400 || Boolean(r.json.errors) || Boolean((r.json.status as { errorResult?: unknown } | undefined)?.errorResult);
      const r = await run(sql);
      if (failed(r)) {
        // Isolate the known sibling defect: the table-level PRIMARY KEY is written AFTER the closing paren of the column list.
        const moved = movePrimaryKeyInside(sql);
        if (moved !== sql && /PRIMARY KEY must be defined/i.test(errorText(r.json))) {
          const retry = await run(moved);
          if (!failed(retry)) return { ok: false, tier, error: `${BQ_PK_OUTSIDE}: rejected as emitted (${errorText(r.json)}), accepted once the constraint is moved inside the column list` };
          // The emulator cannot create a table with a primary key at all ("Unsupported table DDL fields: ['primaryKey']"): judge the rest.
          const stripped = sql.replace(/,?\s*\)\s*PRIMARY KEY\s*\([^)]*\)\s*NOT ENFORCED\s*$/i, "\n)");
          const rest = await run(stripped);
          if (!failed(rest)) return { ok: false, tier, error: `${BQ_PK_OUTSIDE}: as emitted the emulator's parser says (${errorText(r.json)}); moved inside the list it says (${errorText(retry.json)}, i.e. it cannot create primary-key tables); without the PRIMARY KEY clause the DDL is accepted` };
          return { ok: false, tier, error: `${errorText(rest.json)} (judged without the PRIMARY KEY clause; as emitted: ${errorText(r.json)})` };
        }
        return { ok: false, tier, error: errorText(r.json) };
      }
    }
    return { ok: true, tier };
  } catch (e) {
    return { ok: false, tier, error: `emulator call failed: ${(e as Error).message}` };
  } finally {
    await dropBigQuery(dataset);
  }
}

async function dropBigQuery(dataset: string): Promise<void> {
  if (!dataset.startsWith(BIGQUERY_PREFIX)) return;
  try { await call("DELETE", `${BIGQUERY}/bigquery/v2/projects/${PROJECT}/datasets/${dataset}?deleteContents=true`); } catch { /* swept later */ }
}

/** Every item of a paged list (follows `nextPageToken`; bounded). */
async function listAll(url: string, key: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let token: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const sep = url.includes("?") ? "&" : "?";
    const r = await call("GET", token ? `${url}${sep}pageToken=${encodeURIComponent(token)}` : url);
    items.push(...(((r.json[key] as Array<Record<string, unknown>> | undefined) ?? [])));
    token = typeof r.json.nextPageToken === "string" && r.json.nextPageToken !== "" ? r.json.nextPageToken : undefined;
    if (!token) break;
  }
  return items;
}

/** Drops anything with this run's prefix that is still there; returns what remains (should be empty). */
export async function sweep(): Promise<{ spanner: string[]; bigquery: string[] }> {
  const remaining = { spanner: [] as string[], bigquery: [] as string[] };
  const spannerIds = async (): Promise<string[]> => (await listAll(dbBase, "databases")).map((d) => String(d.name).split("/").pop() ?? "").filter((id) => id.startsWith(SPANNER_PREFIX));
  try {
    for (const id of await spannerIds()) await dropSpanner(id);
    remaining.spanner = await spannerIds();
  } catch { /* emulator gone */ }
  const base = `${BIGQUERY}/bigquery/v2/projects/${PROJECT}/datasets`;
  const bigqueryIds = async (): Promise<string[]> => (await listAll(base, "datasets")).map((d) => String((d.datasetReference as { datasetId: string }).datasetId)).filter((id) => id.startsWith(BIGQUERY_PREFIX));
  try {
    for (const id of await bigqueryIds()) await dropBigQuery(id);
    remaining.bigquery = await bigqueryIds();
  } catch { /* emulator gone */ }
  return remaining;
}
