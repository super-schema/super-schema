// @vitest-environment node
/**
 * The older role-less guards of src/lib/action-context.ts (`inActiveTenant`, `isInActiveTenant`, `targetInActiveTenant`, `runMutation(run)` and
 * `withOwnedTarget(target, run)` without an action) still work, as adapters, until access-control Task 5 gives every caller its action. Every
 * line that still uses one carries `TODO(access-control task 5)`, so that task (and the deny-by-default scan) can list what is left, and a
 * NEW use of an adapter cannot slip in unmarked: a new guarded call passes an action (`runMutation({ action, resource }, run)`,
 * `withOwnedTarget("<action>", target, run)`) or asks `authorize` / `authorizeSubject`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MARKER = "TODO(access-control task 5)";

/** A call of a role-less adapter, not a call that names an action (`runMutation({` / `withOwnedTarget("`). */
const ADAPTER_CALL = /\b(inActiveTenant|isInActiveTenant|targetInActiveTenant|runMutation|withOwnedTarget)\(/;
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
  it("every use carries the marker access-control Task 5 searches for", () => {
    const unmarked = adapterUses().filter((use) => !use.marked);
    expect(unmarked.map((use) => `${use.file}:${use.line}  ${use.text.slice(0, 100)}`)).toEqual([]);
  });

  it("the scan itself finds the uses (it is not vacuous)", () => {
    expect(adapterUses().length).toBeGreaterThan(30);
  });

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
  });
});
