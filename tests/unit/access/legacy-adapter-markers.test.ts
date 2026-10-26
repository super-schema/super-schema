// @vitest-environment node
/**
 * The older role-less guards of src/lib/action-context.ts (`inActiveTenant`, `isInActiveTenant`, `targetInActiveTenant`, `runMutation(run)` and
 * `withOwnedTarget(target, run)` without an action, and the `getActionContext` chain) asked the ACTIVE TENANT only and no role. Access-control
 * Task 5 gave every caller its action, so NOTHING outside action-context.ts uses one any more (they stay exported, with their own tests, until
 * the cleanup removes them): this scan keeps it so. A new guarded call passes an action (`runMutation({ action, resource }, run)`,
 * `withOwnedTarget("<action>", target, run)`) or asks `authorize` / `authorizeSubject` / `guardSubject`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MARKER = "TODO(access-control task 5)";

/** A call of a role-less adapter, not a call that names an action (`runMutation({` / `withOwnedTarget("`). */
const ADAPTER_CALL = /\b(inActiveTenant|isInActiveTenant|targetInActiveTenant|runMutation|withOwnedTarget|getActionContext)\(/;
const GUARDED_CALL = /\b(runMutation\(\s*\{|withOwnedTarget\(\s*["'`])/;

/** Where the adapters are defined, and nothing else is exempt. */
const DEFINITION_FILE = join("src", "lib", "action-context.ts");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx)$/.test(name)) found.push(full);
  }
  return found;
}

const isCommentOrImport = (line: string) => /^\s*(\/\/|\*|\/\*|import\s)/.test(line);

function adapterUses(): Array<{ file: string; line: number; text: string; marked: boolean }> {
  const uses: Array<{ file: string; line: number; text: string; marked: boolean }> = [];
  for (const file of sourceFiles("src")) {
    if (file === DEFINITION_FILE) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        if (isCommentOrImport(text) || !ADAPTER_CALL.test(text) || GUARDED_CALL.test(text)) return;
        uses.push({ file, line: index + 1, text: text.trim(), marked: text.includes(MARKER) });
      });
  }
  return uses;
}

describe("legacy role-less guard adapters", () => {
  it("no source file uses a role-less adapter (every caller asks the policy)", () => {
    expect(adapterUses().map((use) => `${use.file}:${use.line}  ${use.text.slice(0, 100)}`)).toEqual([]);
    // a whole-repository scan: over the default 5 s under the load of the whole suite, so a limit of its own
  }, 60_000);

  it("the scan itself recognises an adapter call and a guarded one (it is not vacuous, now that Task 5b moved the callers)", () => {
    const adapter = (line: string) => ADAPTER_CALL.test(line) && !GUARDED_CALL.test(line);
    expect(adapter("    if (!(await inActiveTenant(kind, id))) return;")).toBe(true);
    expect(adapter("  return runMutation(async (ctx) => save(ctx), 'x');")).toBe(true);
    expect(adapter("  return withOwnedTarget(target, async () => save());")).toBe(true);
    expect(adapter('  return runMutation({ action: "entity.write", resource }, run);')).toBe(false);
    expect(adapter('  return withOwnedTarget("event.write", target, run);')).toBe(false);
  }, 30_000);

  it("a marker is only ever on a line that is an adapter use (no stale markers)", () => {
    const stale: string[] = [];
    for (const file of sourceFiles("src")) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, index) => {
          if (!text.includes(MARKER) || isCommentOrImport(text)) return;
          if (!ADAPTER_CALL.test(text) || GUARDED_CALL.test(text)) stale.push(`${file}:${index + 1}`);
        });
    }
    expect(stale).toEqual([]);
    // a whole-repository scan, like the one above: a limit of its own
  }, 60_000);
});
