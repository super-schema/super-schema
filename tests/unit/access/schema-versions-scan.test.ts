// @vitest-environment node
/**
 * KD-046 stays closed: the stored generated schemas of an entity (`metadata.schemaVersions`) hold the files of every entity of the closure they were made
 * from, a wider role's included, so each place in `src` that READS them either hands them to the reader through the redaction
 * (`src/lib/access/schema-version-redaction.ts`) or is on the list below with the reason why it may see the stored value whole. A new reader that is on
 * neither list fails this scan, which says what to do.
 *
 * Reads the syntax tree: a mention counts when it is an identifier or a string with that name inside a top-level function or `const` of a module
 * (a comment names nothing). The entries are `"<file>#<function>"`; a mention outside every function is `"<file>#<module>"`.
 *
 * Two lists:
 *  - REDACTED: the function must itself call one of the redaction functions (checked on the syntax tree: delete the call and this fails);
 *  - STORED: needs the whole stored value, with the reason. These are the writers (a version is stored from the full list, never from a redacted copy), the
 *    readers that return nothing of a file or an output, and the platform administrator's git export.
 * And EXITS: places that hand an entity's metadata or audit state to a caller WITHOUT naming `schemaVersions`; each must call a redaction function.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../helpers/access-scan";

const REDACTION = new Set(["redactSchemaVersions", "redactSchemaVersionsMap", "redactEntityMetadata", "omitSchemaVersions", "withoutStoredSchemaVersions"]);
const NAME = "schemaVersions";
const A = "src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions.ts";

/** Places that return the stored versions to a reader: each calls a redaction function. */
const REDACTED = new Set<string>([`${A}#getSchemaVersionsAction`]);

/** Places that may see the stored value whole, and why. */
const STORED = new Map<string, string>([
  [`${A}#METADATA_KEY_ACTIONS`, "names the key to ask `entity.publish` + `deploy.run` for when a client writes it through updateEntityMetadataAction (a guard table, no data)"],
  [`${A}#generateSchema`, "WRITER: adds a version to the stored list and writes the whole list back; the caller's own generation is what it returns (KD-045 closed it). The exported generateSchemaAction is its wrapper and names no key"],
  [`${A}#publishSchemaAction`, "WRITER: flips a version's status in the stored list; returns a status and a message, never a file or an output"],
  [`${A}#deploySchemaAction`, "WRITER: flips a version's status in the stored list; returns a status, never a file or an output"],
  [`${A}#buildEmissionTargets`, "reads which targets have a version and the latest version NUMBER for the Deployments tab; nothing of a file or an output"],
  [`${A}#getEntityDeploymentStatusAction`, "returns deployment status built from target names and version numbers; nothing of a file or an output"],
  [`${A}#markEntityDeployedAction`, "reads the latest version NUMBER to record a deployment; returns success only"],
  [`${A}#checkTargetDriftAction`, "compares the latest and the deployed `output` strings INSIDE the function and returns a drift report of version numbers and a sentence; the strings never leave it"],
  ["src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab.tsx#SchemasTab", "CLIENT: holds what getSchemaVersionsAction returned, which is already the reader's redacted copy"],
  ["src/lib/entity-versioning/entity-snapshot.ts#withoutSchemaVersions", "REMOVES the key from what a published version freezes (a published snapshot never carries the stored schemas)"],
  ["src/lib/entity-versioning/draft-state.ts#<module>", "lists the metadata keys that are not part of an entity's draft (a key name, no data)"],
  ["src/lib/validation/entity-alerts.ts#generateTargetDriftAlerts", "reads `entityVersion` of the latest version per target to raise an alert; the alert carries target names and numbers, never a file"],
  ...["selectedVersions", "exportedTargetSummary", "planEntity", "generateExportFiles", "toExportEntityInput"].map(
    (name): [string, string] => [
      `src/services/git.service.ts#${name}`,
      "the git export writes the stored file sets of entities into a repository: a platform administrator's act (every async function of the service asks `git.manage`, a GLOBAL administrator, who reads every entity, so there is nothing to redact), and nothing outside the services imports it (checked below)",
    ]
  ),
]);

/** Exits that return an entity's metadata or an audit state without naming the key: each must call a redaction function. */
const EXITS = new Map<string, string>([
  ["src/services/entity.service.ts#getEntityById", "returns the entity row (the v1 `GET /schemas/:id` answer): the stored versions are redacted for the caller"],
  ["src/services/entity.service.ts#getEntities", "returns the entity rows: the stored versions are left out"],
  ["src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/load-entity-workspace.ts#loadEntityWorkspace", "the props of the entity page (sent to the browser): the stored versions are left out"],
  ["src/app/(dashboard)/governance/retention/actions.ts#getEntitiesForRetentionAction", "the retention table's rows (sent to the browser): the stored versions are left out"],
  ["src/services/change-history.service.ts#auditRecordsToTimeline", "the entity's change log returns each audit entry's before/after state, which holds the whole row: the stored versions are left out"],
]);

type Mention = { key: string; calls: Set<string> };

/** The name of a top-level statement, or `<module>` for one that declares nothing callable. */
function statementName(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    const first = statement.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name) && first.initializer && (ts.isArrowFunction(first.initializer) || ts.isFunctionExpression(first.initializer) || ts.isCallExpression(first.initializer))) return first.name.text;
  }
  return "<module>";
}

/** Every function (by name) of a module with whether it mentions `name` and which functions it calls, from the syntax tree. */
function analyze(text: string, file: string, name: string): { mentions: Mention[]; calls: Map<string, Set<string>> } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const mentions = new Map<string, Mention>();
  const calls = new Map<string, Set<string>>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    const owner = statementName(statement);
    const key = `${file}#${owner}`;
    const called = calls.get(key) ?? new Set<string>();
    calls.set(key, called);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
        if (callee) called.add(callee);
      }
      const named =
        (ts.isIdentifier(node) && node.text === name) ||
        ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === name && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent));
      if (named) mentions.set(key, mentions.get(key) ?? { key, calls: called });
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  return { mentions: [...mentions.values()], calls };
}

const files = listSourceFiles("src", /\.(ts|tsx)$/);
/** The redaction module is the boundary itself: it names the key because it is what removes the files from it. */
const BOUNDARY = "src/lib/access/schema-version-redaction.ts";
const analyses = files.filter((file) => file !== BOUNDARY).map((file) => ({ file, ...analyze(readFileSync(file, "utf8"), file, NAME) }));
const found = analyses.flatMap((a) => a.mentions);
const callsOf = (key: string): Set<string> => {
  const file = key.slice(0, key.indexOf("#"));
  return analyses.find((a) => a.file === file)?.calls.get(key) ?? new Set();
};
const callsRedaction = (key: string) => [...callsOf(key)].some((callee) => REDACTION.has(callee));

// Reads every source file of `src` (the readers, and the importers of the repository-export service): over the default 5 s under the load of the whole unit suite, so a limit
// of its own for every test here (the other whole-repository scans of this directory have one).
describe("every reader of the stored generated schemas is redacted or says why not (KD-046)", { timeout: 60_000 }, () => {
  it("the scan finds the readers (it is not vacuous)", () => {
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(found.some((m) => m.key === `${A}#getSchemaVersionsAction`)).toBe(true);
  });

  it("no function mentions `schemaVersions` without being on a list: a new reader must redact (redactSchemaVersions) or be recorded with its reason", () => {
    const unlisted = found.map((m) => m.key).filter((key) => !REDACTED.has(key) && !STORED.has(key));
    expect(unlisted).toEqual([]);
  });

  it("every entry of the lists still exists (a deleted or renamed function leaves a stale reason behind)", () => {
    const keys = new Set(found.map((m) => m.key));
    expect([...REDACTED, ...STORED.keys()].filter((key) => !keys.has(key))).toEqual([]);
  });

  it("a redacted reader calls the redaction", () => {
    expect([...REDACTED].filter((key) => !callsRedaction(key))).toEqual([]);
  });

  it("an exit that returns an entity's metadata or an audit state calls the redaction, and exists", () => {
    const missing = [...EXITS.keys()].filter((key) => !callsOf(key).size && !analyses.some((a) => a.calls.has(key)));
    expect(missing).toEqual([]);
    expect([...EXITS.keys()].filter((key) => !callsRedaction(key))).toEqual([]);
  });

  it("the git export is a platform administrator's act (the reason its entries give): every async function asks `git.manage`, and nothing outside the services imports any", () => {
    const git = readFileSync("src/services/git.service.ts", "utf8");
    const asyncFunctions = git.match(/^export async function \w+/gm) ?? [];
    expect(asyncFunctions.length).toBeGreaterThanOrEqual(6);
    expect(asyncFunctions).not.toContain("export async function exportEntity");
    expect((git.match(/ctxCan\(ctx, "git\.manage"\)/g) ?? []).length).toBe(asyncFunctions.length);
    // Mounting one (a route or an action) is a decision to review: it would hand file sets to whoever calls it.
    const importers = files.filter((file) => !file.startsWith("src/services/git") && /from "(@\/services\/git(-pr)?\.service|\.\/git(-pr)?\.service)"/.test(readFileSync(file, "utf8")));
    expect(importers).toEqual([]);
  });

  it("the analysis itself sees a reader, a call and a comment (self-test)", () => {
    const text = [
      "// schemaVersions in a comment",
      "export function reads(meta: any) { return meta.schemaVersions; }",
      "export const arrow = async (m: any) => redactSchemaVersions(db, m['schemaVersions'], {});",
      "const unrelated = 1;",
    ].join("\n");
    const out = analyze(text, "x.ts", NAME);
    expect(out.mentions.map((m) => m.key)).toEqual(["x.ts#reads", "x.ts#arrow"]);
    expect([...(out.calls.get("x.ts#arrow") ?? [])]).toContain("redactSchemaVersions");
    expect([...(out.calls.get("x.ts#reads") ?? [])]).not.toContain("redactSchemaVersions");
    expect(analyze("// schemaVersions\nconst a = 'x';", "y.ts", NAME).mentions).toEqual([]);
  });
});
