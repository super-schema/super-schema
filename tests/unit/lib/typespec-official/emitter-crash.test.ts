/**
 * The Schemas tab never shows an emitter crash's raw output: banner, `Emitter "x" crashed!`, a stack of file:// URLs and
 * install paths. `tsp` itself is faked here (it is the one thing that cannot be made to crash on demand: the installed
 * emitters do not throw), with the text a real crash prints; everything else — workspace, symlink, config — is real.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
// These tests shell out to the real TypeSpec compiler / emitters (~1 s each); under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000 });
import { EMITTER_CRASH_RAW } from "../../../helpers/emitter-crash";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(() => undefined, { [promisify.custom]: execFileMock });
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { GENERIC_EMITTER_FAILURE, MAX_LOGGED_EMITTER_OUTPUT } from "@/lib/typespec-official/emitter-diagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  execFileMock.mockReset();
});

const entity = { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" } };
const fields = [{ id: "f1", name: "transactionId", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0 }];

describe("an emitter that crashes", () => {
  it.each([["spanner"], ["postgresql"], ["bigquery"], ["avro"]])("%s: the Schemas tab gets the generic message, the raw text goes to the server log", async (target) => {
    execFileMock.mockRejectedValue(Object.assign(new Error("Command failed: tsp compile"), { stdout: EMITTER_CRASH_RAW, stderr: "" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.output).toBe("");
    expect(result.errors).toEqual([{ message: GENERIC_EMITTER_FAILURE }]);
    const shown = JSON.stringify(result);
    for (const leak of ["file://", " at ", "/Users", "/var/folders", "ENOENT", "crashed", "TypeError"]) expect(shown, `leaks "${leak}"`).not.toContain(leak);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("[typespec-emitter]");
    expect(String(log.mock.calls[0][1])).toContain('Emitter "boom" crashed!');
  });

  it("a huge crash output (execFile allows 10 MB) is logged cut to 20,000 characters, not whole", async () => {
    execFileMock.mockRejectedValue(Object.assign(new Error("Command failed"), { stdout: `${EMITTER_CRASH_RAW}${"x".repeat(10 * 1024 * 1024)}`, stderr: "" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "bigquery");

    expect(result.errors).toEqual([{ message: GENERIC_EMITTER_FAILURE }]);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = String(log.mock.calls[0][1]);
    expect(logged.startsWith("TypeSpec compiler v1.10.0")).toBe(true);
    expect(logged).toMatch(/\.\.\. \[\d+ more characters cut\]$/);
    expect(logged.length).toBeLessThan(MAX_LOGGED_EMITTER_OUTPUT + 100);
  });

  it("a compile with an error diagnostic is NOT logged as a crash (the diagnostic is the message)", async () => {
    execFileMock.mockRejectedValue(
      Object.assign(new Error("Command failed"), { stdout: "../../tmp/x/main.tsp:8:7 - error @typespec/bigquery/missing-primary-key: Table 'T' must have at least one @primaryKey property.\n", stderr: "" })
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "bigquery");

    expect(result.errors).toEqual([{ message: "@typespec/bigquery/missing-primary-key: Table 'T' must have at least one @primaryKey property." }]);
    expect(log).not.toHaveBeenCalled();
  });
});
