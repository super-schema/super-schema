import { describe, it, expect } from "vitest";
import { EMITTER_CRASH_RAW } from "../../../helpers/emitter-crash";
import { describeEmitterFailure, errorDiagnostics, warningDiagnostics, replaceFilePaths, boundedForLog, MAX_LOGGED_EMITTER_OUTPUT, GENERIC_EMITTER_FAILURE } from "@/lib/typespec-official/emitter-diagnostics";

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

  it("removes workspace paths from a diagnostic's own text", () => {
    expect(describeEmitterFailure(`error import-not-found: Couldn't resolve import "./x.tsp" in /var/folders/3y/abc/T/superschema-tsp-x1/main.tsp`)).toBe(
      `import-not-found: Couldn't resolve import "./x.tsp" in <path>`
    );
  });

  it("does not mistake a package-scoped diagnostic code for a path", () => {
    expect(describeEmitterFailure(`${WORKSPACE}/main.tsp:2:3 - error @typespec/spanner/invalid-row-deletion-column: Column 'x' does not exist on model 'M'.`)).toBe(
      "@typespec/spanner/invalid-row-deletion-column: Column 'x' does not exist on model 'M'."
    );
  });

  it("says only that the emitter failed when there is no error diagnostic — never the raw text (an emitter crash, a stack, a path)", () => {
    const message = describeEmitterFailure(EMITTER_CRASH_RAW);

    expect(message).toBe(GENERIC_EMITTER_FAILURE);
    expect(GENERIC_EMITTER_FAILURE).toBe("The TypeSpec emitter failed.");
    for (const leak of ["file://", "at ", "/Users", "/var/folders", "/private", "ENOENT", "crashed", "TypeError", "Compiling"]) {
      expect(message, `the message leaks "${leak}"`).not.toContain(leak);
    }
    for (const raw of [`ENOENT: no such file or directory, scandir '/var/folders/3y/abc/T/superschema-tsp-x1/out'`, "   \n", "Could not create a TypeSpec workspace: EACCES /tmp/a/b/c"]) {
      expect(describeEmitterFailure(raw)).toBe(GENERIC_EMITTER_FAILURE);
    }
  });
});

describe("errorDiagnostics / warningDiagnostics", () => {
  it("tell errors from warnings and find none in a crash", () => {
    const raw = `${WORKSPACE}/main.tsp:3:5 - warning @typespec/spanner/unsupported-type: Type 'plainTime' is not supported by the Spanner emitter and will be skipped.\n${WORKSPACE}/main.tsp:4:1 - error x/y: z`;

    expect(warningDiagnostics(raw)).toEqual(["@typespec/spanner/unsupported-type: Type 'plainTime' is not supported by the Spanner emitter and will be skipped."]);
    expect(errorDiagnostics(raw)).toEqual(["x/y: z"]);
    expect(errorDiagnostics(EMITTER_CRASH_RAW)).toEqual([]);
    expect(warningDiagnostics(EMITTER_CRASH_RAW)).toEqual([]);
  });
});

describe("replaceFilePaths", () => {
  it("replaces workspace paths and leaves package-scoped codes alone", () => {
    expect(replaceFilePaths("see /var/folders/3y/abc/T/superschema-tsp-x1/out and ../../tmp/a/b")).toBe("see <path> and <path>");
    expect(replaceFilePaths("@typespec/bigquery/missing-primary-key")).toBe("@typespec/bigquery/missing-primary-key");
    expect(replaceFilePaths("/a/b/c", "…")).toBe("…");
  });

  it("is stateless: the same text gives the same answer however often it is called (no shared /g lastIndex)", () => {
    const text = "x /var/folders/3y/abc/T/superschema-tsp-x1/out y";
    const answers = Array.from({ length: 4 }, () => replaceFilePaths(text));

    expect(new Set(answers)).toEqual(new Set(["x <path> y"]));
  });
});

describe("boundedForLog", () => {
  it("passes a short text through and cuts a long one to 20,000 characters, counting the rest", () => {
    expect(boundedForLog("short")).toBe("short");
    expect(boundedForLog("z".repeat(MAX_LOGGED_EMITTER_OUTPUT))).toHaveLength(MAX_LOGGED_EMITTER_OUTPUT);

    const bounded = boundedForLog("z".repeat(10 * 1024 * 1024));
    expect(bounded.startsWith("z".repeat(MAX_LOGGED_EMITTER_OUTPUT))).toBe(true);
    expect(bounded.endsWith(`... [${10 * 1024 * 1024 - MAX_LOGGED_EMITTER_OUTPUT} more characters cut]`)).toBe(true);
    expect(bounded.length).toBeLessThan(MAX_LOGGED_EMITTER_OUTPUT + 100);
    expect(MAX_LOGGED_EMITTER_OUTPUT).toBe(20_000);
  });
});
