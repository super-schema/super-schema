import { describe, it, expect } from "vitest";
import { describeEmitterFailure } from "@/lib/typespec-official/emitter-diagnostics";

const WORKSPACE = "../../../../../../../var/folders/3y/4_9l52615m14r9g_pp2b1rhw0000gp/T/superschema-tsp-REjWB5";

describe("describeEmitterFailure", () => {
  it("keeps the error diagnostic of a failed compile and drops the banner, the workspace path and the progress lines", () => {
    const raw =
      "TypeSpec compiler v1.10.0\n\nDiagnostics were reported during compilation:\n\n" +
      `${WORKSPACE}/main.tsp:8:7 - error @typespec/bigquery/missing-primary-key: Table 'TestEntity' must have at least one @primaryKey property.\n\n` +
      `Found 1 error.\n\n\n- Compiling...\n✔ Compiling\n- Running @typespec/bigquery...\n× @typespec/bigquery 2ms ${WORKSPACE}/out/`;

    expect(describeEmitterFailure(raw)).toBe("@typespec/bigquery/missing-primary-key: Table 'TestEntity' must have at least one @primaryKey property.");
  });

  it("lists every error, leaves warnings out and counts the errors beyond five", () => {
    const line = (n: number) => `${WORKSPACE}/main.tsp:${n}:1 - error ambiguous-symbol: "schema${n}" is an ambiguous name`;
    const raw = [`${WORKSPACE}/main.tsp:1:1 - warning deprecated: old`, ...[1, 2, 3, 4, 5, 6, 7].map(line)].join("\n");

    const lines = describeEmitterFailure(raw).split("\n");

    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('ambiguous-symbol: "schema1" is an ambiguous name');
    expect(lines[5]).toBe("(and 2 more)");
    expect(lines.join("\n")).not.toContain("deprecated");
  });

  it("understands a diagnostic without a source location", () => {
    expect(describeEmitterFailure("error invalid-emitter: Emitter '@typespec/nope' is not installed.")).toBe(
      "invalid-emitter: Emitter '@typespec/nope' is not installed."
    );
  });

  it("removes absolute and relative workspace paths from a text that has no diagnostics", () => {
    const text = describeEmitterFailure(`ENOENT: no such file or directory, scandir '/var/folders/3y/abc/T/superschema-tsp-x1/out' (see ${WORKSPACE}/main.tsp)`);

    expect(text).toBe("ENOENT: no such file or directory, scandir '<path>' (see <path>)");
  });

  it("does not mistake a package-scoped diagnostic code for a path", () => {
    expect(describeEmitterFailure(`${WORKSPACE}/main.tsp:2:3 - error @typespec/spanner/invalid-row-deletion-column: Column 'x' does not exist on model 'M'.`)).toBe(
      "@typespec/spanner/invalid-row-deletion-column: Column 'x' does not exist on model 'M'."
    );
  });

  it("never returns an empty message", () => {
    expect(describeEmitterFailure("   \n")).toBe("The TypeSpec emitter failed.");
  });
});
