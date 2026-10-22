/**
 * Runs corpus cases: build rows (serially, env-scoped) -> generate every enabled target (bounded concurrency) -> validate each output
 * -> round trip (JSON Schema cases). Never hangs (every step has a timeout) and cleans up its temp dirs / emulator objects.
 */
import { ALL_TARGETS, type CorpusCase, type TargetKey } from "../../fixtures/corpus/types";
import { matchKnownIssue } from "../../fixtures/corpus/known-issues";
import { buildCase, type BuiltCase } from "./build-rows";
import { createLimiter, generateTarget, withTimeout, type TargetOutcome } from "./run-case";
import { validateOffline, type Validation } from "./validators";
import { validateSpanner, validateBigQuery, probeEmulators, type EmulatorState } from "./emulators";
import { compareRoundTrip, type RoundTripResult } from "./roundtrip";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";

/** The wording of db-source.ts warnings that say the DDL will not run (or will be rejected) as emitted. */
const APP_DDL_WARNING = /does not quote it|starts with a digit|system column|will be rejected|truncated or rejected|reject the DDL/i;

export interface CaseResult {
  id: string;
  kind: CorpusCase["kind"];
  title: string;
  build: { ok: true; entityCount: number; fieldCount: number; importWarnings: string[] } | { ok: false; reason: string };
  targets: Partial<Record<TargetKey, TargetOutcome>>;
  roundTrip?: RoundTripResult;
  /** The import was refused and the case said it would be (expectations.importError). */
  importRefused?: boolean;
  /** Problems with the case's own expectations (import warning patterns that did not match). */
  expectationProblems: string[];
  ms: number;
}

export interface RunOptions {
  emulators: boolean;
  roundTrip: boolean;
  /** `tsp` children at once. */
  concurrency?: number;
  /** Cases handled at once (their targets still share the `tsp` limiter). */
  caseConcurrency?: number;
  budgetMs?: number;
  emitTimeoutMs?: number;
  onProgress?: (done: number, total: number, id: string) => void;
}

/** The targets the app enables (catalog.ts), in the matrix order. */
export function enabledTargets(): TargetKey[] {
  const enabled = new Set(getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab && t.runtime === "typespec-cli").map((t) => t.key));
  const targets = ALL_TARGETS.filter((t) => enabled.has(t));
  // A newly enabled target must be added to ALL_TARGETS (and its validator) deliberately.
  const unknown = [...enabled].filter((k) => !(ALL_TARGETS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`catalog enables targets the corpus does not know: ${unknown.join(", ")}`);
  return targets;
}

async function withEnv<T>(env: Record<string, string> | undefined, run: () => Promise<T>): Promise<T> {
  if (!env) return run();
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await run(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function schemaNameOf(output: string): string {
  return /CREATE SCHEMA IF NOT EXISTS (\S+?);/.exec(output)?.[1] ?? "corpus";
}

async function validateOutput(target: TargetKey, outcome: TargetOutcome, state: EmulatorState | undefined, emuLimit: ReturnType<typeof createLimiter>): Promise<Validation & { tierName?: "spanner" | "bigquery" | "java" }> {
  const output = outcome.output ?? "";
  const offline = await withTimeout(validateOffline(target, output), 90000, `validate ${target}`).catch((e: Error): Validation => ({ ok: false, tier: "validator", error: e.message }));
  if (offline) return offline.skipped ? { ...offline, tierName: "java" } : offline;
  if (target === "spanner") {
    if (!state?.spanner) return { ok: true, skipped: true, tierName: "spanner", tier: `spanner emulator not used (${state?.reasons.find((r) => r.startsWith("spanner")) ?? "disabled"})` };
    return emuLimit(() => validateSpanner(output));
  }
  if (!state?.bigquery) return { ok: true, skipped: true, tierName: "bigquery", tier: `bigquery emulator not used (${state?.reasons.find((r) => r.startsWith("bigquery")) ?? "disabled"})` };
  return emuLimit(() => validateBigQuery(output, schemaNameOf(output)));
}

export async function runCases(cases: CorpusCase[], options: RunOptions): Promise<CaseResult[]> {
  const started = Date.now();
  const limit = createLimiter(options.concurrency ?? 4);
  const emuLimit = createLimiter(1);
  const targets = enabledTargets();
  const state = options.emulators ? await probeEmulators() : undefined;
  const results: CaseResult[] = new Array(cases.length);
  let done = 0;

  const buildOne = (c: CorpusCase) => withTimeout(buildCase(c), 120000, `build ${c.id}`).catch((e: Error) => ({ ok: false as const, reason: e.message }));

  const processCase = async (i: number, b: Awaited<ReturnType<typeof buildCase>>): Promise<void> => {
    const c = cases[i];
    const t0 = Date.now();
    const result: CaseResult = { id: c.id, kind: c.kind, title: c.title, build: b.ok ? { ok: true, entityCount: b.value.entityCount, fieldCount: b.value.fields.length, importWarnings: b.value.importWarnings } : { ok: false, reason: b.reason }, targets: {}, expectationProblems: [], ms: 0 };
    results[i] = result;
    done += 1;
    if (!b.ok) {
      if (c.expectations.importError) {
        if (c.expectations.importError.test(b.reason)) result.importRefused = true;
        else result.expectationProblems.push(`import refused with an unexpected message (wanted ${c.expectations.importError}): ${b.reason}`);
      }
      return;
    }
    if (c.expectations.importError) result.expectationProblems.push(`the import was expected to be refused (${c.expectations.importError}) but succeeded`);
    for (const pattern of c.expectations.importWarnings ?? []) {
      if (!b.value.importWarnings.some((w) => pattern.test(w))) result.expectationProblems.push(`no import warning matches ${pattern}`);
    }
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs) {
      for (const t of targets) result.targets[t] = { target: t, kind: "SKIPPED", reason: "global time budget exhausted", warnings: [] };
      return;
    }
    await Promise.all(targets.map(async (target) => {
      const outcome = await generateTarget(c, b.value, target, limit, options.emitTimeoutMs ?? 150000);
      if (outcome.output !== undefined && (outcome.kind === "PASS" || outcome.kind === "DEGRADED")) {
        const v0 = Date.now();
        const v = await validateOutput(target, outcome, state, emuLimit);
        outcome.validateMs = Date.now() - v0;
        outcome.validator = v.tier;
        if (v.skipped && v.tierName) outcome.tierSkipped = { tier: v.tierName, reason: v.tier };
        if (!v.skipped && !v.ok) {
          // The app itself says the DDL will not run as is (reserved word, leading digit, limits...): that is a DEGRADED
          // result the validator CONFIRMS, not a failure. Without such a warning a validator failure is a FAIL.
          const explained = (target === "postgresql" || target === "spanner" || target === "bigquery") && outcome.warnings.some((w) => APP_DDL_WARNING.test(w));
          outcome.reason = explained ? `app warned and the validator confirms: ${outcome.warnings.find((w) => APP_DDL_WARNING.test(w))?.slice(0, 140)} | ${v.error?.slice(0, 120)}` : `validate: ${v.error}`;
          outcome.kind = explained ? "DEGRADED" : "FAIL";
        }
      }
      if (outcome.kind === "FAIL") {
        const known = matchKnownIssue(c, target, outcome, b.value);
        if (known) { outcome.expected = `${known.id}: ${known.issue}`; outcome.knownId = known.id; }
      }
      result.targets[target] = outcome;
    }));
    if (options.roundTrip && c.kind === "jsonschema" && c.expectations.roundTrip !== false && b.value.imported) {
      const js = result.targets["json-schema"];
      if (js?.output) {
        const root = b.value.imported.entities.find((e) => e.name === b.value.entity.name) ?? b.value.imported.entities[0];
        // Only the root entity is persisted/emitted, so only its projection is comparable.
        result.roundTrip = compareRoundTrip(root, js.output);
      } else result.roundTrip = { status: "SKIPPED", differences: [], note: "json-schema output unavailable" };
    }
    for (const o of Object.values(result.targets)) delete (o as TargetOutcome).output; // keep results small
    result.ms = Date.now() - t0;
    options.onProgress?.(done, cases.length, c.id);
  };

  // Phase 1: cases that need the process environment as it is. Rows are built serially, then processed by a small pool.
  const plain = cases.map((c, i) => i).filter((i) => !cases[i].expectations.env);
  const built = new Map<number, Awaited<ReturnType<typeof buildCase>>>();
  for (const i of plain) built.set(i, await buildOne(cases[i]));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < plain.length) {
      const i = plain[next];
      next += 1;
      await processCase(i, built.get(i)!);
    }
  };
  await Promise.all(Array.from({ length: options.caseConcurrency ?? 3 }, worker));

  // Phase 2: cases that set environment variables (the classification key / value map): import AND generation both run with them
  // set, one case at a time, because the environment is process-wide.
  for (let i = 0; i < cases.length; i += 1) {
    const env = cases[i].expectations.env;
    if (!env) continue;
    await withEnv(env, async () => processCase(i, await buildOne(cases[i])));
  }
  return results;
}

export interface ProblemOptions {
  /** Validator tiers that may legitimately be missing in this run (spanner, bigquery, java). Used loudly, never by default. */
  allowSkipTiers?: readonly string[];
  /** The case itself, for its allowed skips. */
  allowedSkips?: ReadonlyArray<{ target: string; reason: string }>;
}

/** The tiers a run may skip, from `CORPUS_ALLOW_SKIP_TIERS=spanner,bigquery,java`. */
export function allowedSkipTiersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORPUS_ALLOW_SKIP_TIERS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/** Unexpected problems of one result (empty = the case is green). Skipped work is a problem unless it is explicitly allowed. */
export function problemsOf(result: CaseResult, options: ProblemOptions = {}): string[] {
  const problems = [...result.expectationProblems];
  if (!result.build.ok && !result.importRefused) problems.push(`build failed: ${result.build.reason}`);
  for (const [target, o] of Object.entries(result.targets)) {
    if (!o) continue;
    if (o.kind === "FAIL" && !o.expected) problems.push(`${target}: ${o.reason}`);
    if (o.kind === "SKIPPED" && !options.allowedSkips?.some((s) => s.target === target)) {
      problems.push(`${target}: SKIPPED (${o.reason}) and the case does not allow it`);
    }
    if (o.tierSkipped && !options.allowSkipTiers?.includes(o.tierSkipped.tier)) {
      problems.push(`${target}: validator tier "${o.tierSkipped.tier}" did not run (${o.tierSkipped.reason}); start it, or set CORPUS_ALLOW_SKIP_TIERS=${o.tierSkipped.tier} to accept running without it`);
    }
  }
  if (result.roundTrip?.status === "DEFECT" || result.roundTrip?.status === "REIMPORT_FAILED") {
    problems.push(`round trip ${result.roundTrip.status}: ${result.roundTrip.differences.filter((d) => d.classification === "DEFECT").slice(0, 3).map((d) => d.path).join(", ") || result.roundTrip.note}`);
  }
  return problems;
}

export type { BuiltCase };
