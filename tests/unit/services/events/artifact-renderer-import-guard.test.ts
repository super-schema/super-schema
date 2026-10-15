/**
 * C-C1 through the real renderer sequence (combine -> buildTargetSource -> runTypeSpecEmitterFiles, which spawns
 * `tsp`): a source that names a host script must neither be combined nor ever reach `tsp`, which would LOAD AND
 * EXECUTE the script. The marker file is created by the script itself, so its absence proves it never ran.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineTypeSpecSources } from "@/lib/events/version-source";
import { buildTargetSource } from "@/services/events/artifact-renderer";
import { runTypeSpecEmitterFiles } from "@/lib/typespec-official/emitter.service";

vi.mock("server-only", () => ({}));

let dir: string;
let marker: string;
let script: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "f1-render-"));
  marker = join(dir, "MARKER");
  script = join(dir, "x.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const $decorators = {};\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const part = (source: string) => ({ label: "A@1.0", entityId: "e1", versionId: "v1", rootModel: "A", fields: [], source });
const programFor = (source: string) => ({ root: part(source), deps: [], namespace: "Acme" }) as never;
const JSON_SCHEMA_OPTIONS = { emitAllModels: true, "file-type": "json", bundleId: "A" };

describe("renderer sequence refuses a source that imports a host script (C-C1)", () => {
  it.each([
    ["first-line import without a space", (p: string) => `import"${p}";\nmodel A { x: string; }\n`],
    ["import after a closing brace on the same line", (p: string) => `model A { x: string; } import "${p}";\n`],
    ["relative import", () => 'import "./x.mjs";\nmodel A { x: string; }\n'],
  ])("combine refuses %s and nothing is emitted", async (_name, make) => {
    const source = make(script);
    const combined = combineTypeSpecSources([{ label: "A@1.0", source }]);
    expect(!combined.success && combined.error.code).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["no space", (p: string) => `import"${p}";\n`],
    ["after a brace", (p: string) => `model A { x: string; } import "${p}";\n`],
    ["ordinary", (p: string) => `import "${p}";\n`],
  ])("the emitter itself refuses the final program (%s) before creating a workspace or spawning tsp", async (_name, make) => {
    const mkdtemp = vi.spyOn(fs, "mkdtemp");
    const main = `import "@typespec/json-schema";\n\nnamespace Acme;\n\n${make(script)}`;
    const result = await runTypeSpecEmitterFiles("@typespec/json-schema", main, JSON_SCHEMA_OPTIONS, { timeoutMs: 60_000 });
    expect(!result.success && result.error.code).toBe("TYPESPEC_IMPORT_NOT_ALLOWED");
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("still renders a legitimate multi-model source that imports TypeSpec libraries, through the real tsp", async () => {
    const source = 'import "@typespec/json-schema";\nenum Status { Active, Retired }\nmodel A { id: string; status: Status; line: Line; }\nmodel Line { sku: string; }\n';
    const combined = combineTypeSpecSources([{ label: "A@1.0", source }]);
    expect(combined.success).toBe(true);
    if (!combined.success) return;
    const main = buildTargetSource("json-schema", combined.data, programFor(source));
    const result = await runTypeSpecEmitterFiles("@typespec/json-schema", main, JSON_SCHEMA_OPTIONS, { timeoutMs: 90_000 });
    expect(result.success, !result.success ? result.error.message : "").toBe(true);
    if (!result.success) return;
    const text = result.data.map((f) => f.content).join("\n");
    expect(text).toContain("Line");
    expect(text).toContain("Retired");
  }, 120_000);
});
