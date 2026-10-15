/**
 * TypeSpec import action: the real compiler behind an authenticated, size-capped, time-bounded, sanitized action
 * (final-review D-I1), and the C-C1 import guard end to end (a source that imports a host file never runs it).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ auth: vi.fn(), resolveCurrentUserId: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/lib/compiler/typespec-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compiler/typespec-compiler")>();
  return { ...actual, compileTypeSpecDocument: vi.fn(actual.compileTypeSpecDocument) };
});

import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { MAX_IMPORT_CONTENT_BYTES, IMPORT_COMPILE_TIMEOUT_MS } from "@/lib/compiler/import-limits";
import { AuditUserMissingError } from "@/lib/audit";

let importTypeSpecDocumentAction: typeof import("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions").importTypeSpecDocumentAction;

beforeAll(async () => {
  ({ importTypeSpecDocumentAction } = await import("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions"));
});

const GENERIC = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

const LEGIT = [
  'import "@typespec/http";',
  'import "@typespec/openapi";',
  "using TypeSpec.Http;",
  "",
  "model Pet {",
  "  id: string;",
  "  name: string;",
  "  owner: Owner;",
  "}",
  "",
  "model Owner {",
  "  email: string;",
  "}",
  "",
  "enum Species { Dog, Cat }",
  "",
].join("\n");

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
  vi.mocked(compileTypeSpecDocument).mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  consoleError.mockRestore();
});

describe("importTypeSpecDocumentAction", () => {
  it("still imports a legitimate multi-model source that imports TypeSpec libraries", async () => {
    const result = await importTypeSpecDocumentAction(LEGIT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.models.map((m) => m.name).sort()).toEqual(["Owner", "Pet"]);
    expect(compileTypeSpecDocument).toHaveBeenCalledTimes(1);
  });

  it("rejects empty and non-string content", async () => {
    expect(await importTypeSpecDocumentAction("  \n ")).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(await importTypeSpecDocumentAction(undefined as never)).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(compileTypeSpecDocument).not.toHaveBeenCalled();
  });

  it("requires a session: nothing is compiled without one, or for a session whose user no longer exists", async () => {
    h.auth.mockResolvedValue(null);
    expect(await importTypeSpecDocumentAction(LEGIT)).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    h.auth.mockResolvedValue({ user: { id: "ghost" } });
    h.resolveCurrentUserId.mockRejectedValue(new AuditUserMissingError("ghost"));
    expect(await importTypeSpecDocumentAction(LEGIT)).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    expect(compileTypeSpecDocument).not.toHaveBeenCalled();
  });

  it("refuses content over the size cap (measured in bytes) before compiling", async () => {
    const huge = `${LEGIT}\n// ${"x".repeat(MAX_IMPORT_CONTENT_BYTES)}\n`;
    const result = await importTypeSpecDocumentAction(huge);
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(!result.success && result.error.message).toContain("too large");
    const multibyte = `model A { x: string; } // ${"é".repeat(MAX_IMPORT_CONTENT_BYTES / 2)}`;
    expect(multibyte.length).toBeLessThan(MAX_IMPORT_CONTENT_BYTES);
    expect(await importTypeSpecDocumentAction(multibyte)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(compileTypeSpecDocument).not.toHaveBeenCalled();
  });

  it("gives up on a compile that outlives the timeout (the in-process compile itself cannot be cancelled)", async () => {
    vi.useFakeTimers();
    vi.mocked(compileTypeSpecDocument).mockImplementationOnce(() => new Promise(() => undefined));
    const pending = importTypeSpecDocumentAction(LEGIT);
    await vi.advanceTimersByTimeAsync(IMPORT_COMPILE_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ success: false, error: { code: "COMPILE_TIMEOUT" } });
  });

  it("never returns raw compiler / host text: the original is logged, the caller gets the generic message", async () => {
    vi.mocked(compileTypeSpecDocument).mockRejectedValueOnce(new Error("EACCES: permission denied, mkdir '/srv/app/.typespec-work'"));
    const result = await importTypeSpecDocumentAction(LEGIT);
    expect(result).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: GENERIC } });
    expect(JSON.stringify(result)).not.toContain("srv");
    expect(consoleError.mock.calls.flat().join(" ")).toContain(".typespec-work");
  });

  describe("import guard, end to end with the real compiler (C-C1)", () => {
    let dir: string;
    let marker: string;
    let script: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "f1-import-"));
      marker = join(dir, "MARKER");
      script = join(dir, "x.mjs");
      writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nexport const $decorators = {};\n`);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it.each([
      ["first-line import without a space", (p: string) => `import"${p}";\nmodel A { x: string; }\n`],
      ["import after a closing brace on the same line", (p: string) => `model A { x: string; } import "${p}";\n`],
      ["ordinary import of an absolute path", (p: string) => `import "${p}";\nmodel A { x: string; }\n`],
    ])("never runs a host script named by %s", async (_name, make) => {
      const result = await importTypeSpecDocumentAction(make(script));
      expect(result).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED" } });
      expect(existsSync(marker)).toBe(false);
      expect(compileTypeSpecDocument).toHaveBeenCalledTimes(1); // the guard lives inside the compile entry point
    });
  });
});
