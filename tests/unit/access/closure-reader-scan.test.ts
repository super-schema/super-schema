// @vitest-environment node
/**
 * KD-045 stays closed: every place in `src` that loads a reference closure (an emission, a validation, a preview, a generation, a publish) says
 * whose roles decide what the closure may hold, by passing a reader (`entityReader(...)`). A new caller that forgets it would emit an entity together
 * with entities its caller may not read, so this scan fails for any call of the closure loaders that carries no reader.
 *
 * Reads the syntax tree: the reader must be an identifier (`reader`) or a call (`entityReader(...)`) among the call's ARGUMENTS; a comment or a string
 * naming it counts for nothing. The loaders themselves, which take the reader as a parameter, are not callers.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listSourceFiles } from "../../helpers/access-scan";

/** Functions that build a closure or a document from one. `emitEntity(id, reader)` and the like take the reader last or in an options object. */
const LOADERS = new Set(["loadReferenceClosure", "loadPublishClosure", "emitTargetsForEntity", "emitEntity"]);

/** The one call that FORWARDS the options it was given (its own parameter type carries the reader): file -> loader. */
const FORWARDERS = new Map<string, string>([["src/lib/entity-versioning/publish-closure.ts", "loadReferenceClosure"]]);

type Call = { file: string; line: number; name: string; reader: boolean; forwardsOptions: boolean };

function callsOf(text: string, file: string): Call[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Call[] = [];

  /** Does the node, among its descendants, name the reader (an identifier `reader` or a call of `entityReader`)? */
  const namesReader = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && (node.text === "reader" || node.text === "entityReader")) || ts.forEachChild(node, (child) => (namesReader(child) ? true : undefined)) === true;
  const spreadsOptions = (node: ts.Node): boolean =>
    (ts.isSpreadAssignment(node) && ts.isIdentifier(node.expression) && node.expression.text === "opts") ||
    ts.forEachChild(node, (child) => (spreadsOptions(child) ? true : undefined)) === true;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && LOADERS.has(node.expression.text)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push({
        file,
        line: line + 1,
        name: node.expression.text,
        reader: node.arguments.some(namesReader),
        forwardsOptions: node.arguments.some(spreadsOptions),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("every closure loader call names whose roles decide (KD-045)", () => {
  const files = listSourceFiles("src", /\.(ts|tsx)$/).filter((file) => !file.includes("/generated/"));
  const calls = files.flatMap((file) => callsOf(readFileSync(file, "utf8"), file));

  it("the scan finds the callers (it is not vacuous)", () => {
    expect(new Set(calls.map((call) => call.name))).toEqual(LOADERS);
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });

  it("no call of a loader is without a reader", () => {
    const without = calls.filter((call) => !call.reader && FORWARDERS.get(call.file) !== call.name).map((call) => `${call.file}:${call.line} ${call.name}`);
    expect(without).toEqual([]);
  });

  it("the one forwarder passes its own options on, and the callers of that forwarder carry the reader", () => {
    for (const [file, name] of FORWARDERS) {
      const own = calls.filter((call) => call.file === file && call.name === name);
      expect(own).toHaveLength(1);
      expect(own[0].forwardsOptions).toBe(true);
    }
    const publish = calls.filter((call) => call.name === "loadPublishClosure");
    expect(publish.length).toBeGreaterThan(0);
    expect(publish.every((call) => call.reader)).toBe(true);
  });

  it("the analysis itself sees a missing reader (self-test)", () => {
    expect(callsOf("loadReferenceClosure(db, t, id, 'draft');", "x.ts").map((c) => c.reader)).toEqual([false]);
    expect(callsOf("loadReferenceClosure(db, t, id, 'draft', { reader });", "x.ts").map((c) => c.reader)).toEqual([true]);
    expect(callsOf("emitEntity(id, entityReader(p.assignments));", "x.ts").map((c) => c.reader)).toEqual([true]);
    expect(callsOf("emitEntity(id /* reader */);", "x.ts").map((c) => c.reader)).toEqual([false]);
    expect(callsOf("emitEntity(id, 'reader');", "x.ts").map((c) => c.reader)).toEqual([false]);
    expect(callsOf("// loadReferenceClosure(db)\nconst s = 'emitEntity(id, reader)';", "x.ts")).toEqual([]);
    expect(callsOf("loadReferenceClosure(db, t, id, m, { rootAtDraft: true, ...opts });", "x.ts").map((c) => [c.reader, c.forwardsOptions])).toEqual([[false, true]]);
  });
});
