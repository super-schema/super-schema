/**
 * TypeSpec import action: the real compiler behind an authenticated, size-capped, time-bounded, sanitized action
 * (final-review D-I1), and the C-C1 import guard end to end (a source that imports a host file never runs it).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { sessionPrincipalModule } from "../../helpers/access-mocks";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ auth: vi.fn(), resolveCurrentUserId: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant-1" }));
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

  it("refuses a text the compiler refuses: its errors are the answer, and a misspelt type is not imported as a type of its own", async () => {
    const result = await importTypeSpecDocumentAction("model Order {\n  total: Moneyy;\n}\n");
    expect(result).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(!result.success && result.error.message).toBe("The TypeSpec does not compile: Unknown identifier Moneyy");
    expect(compileTypeSpecDocument).toHaveBeenCalledTimes(1);
  });

  it("a name the text does not declare is refused with a hint that it must be declared in the text", async () => {
    const result = await importTypeSpecDocumentAction("model Order {\n  customer: Customer;\n}\n");
    expect(result).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(!result.success && result.error.message).toBe("The TypeSpec does not compile: Unknown identifier Customer");
    expect(!result.success && result.error.suggestedFix).toContain("declared in the TypeSpec");
  });

  it("refuses a field typed with void: it is no type of the app, and is not imported as a value", async () => {
    const result = await importTypeSpecDocumentAction("model Order {\n  note: void;\n}\n");
    expect(result).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(!result.success && result.error.message).toBe('Model "Order": field "note" is typed "void", which is not a type of this app: use a TypeSpec standard type, an enum, a union or a model of the text.');
  });

  it("imports a field typed with a union of string values as an enum field with those symbols, never as a type named string | string", async () => {
    const result = await importTypeSpecDocumentAction('model Order {\n  status: "open" | "closed";\n  tags: ("a" | "b")[];\n}\n');
    expect(result.success).toBe(true);
    if (!result.success) return;
    const fields = result.data.models.find((m) => m.name === "Order")?.fields ?? [];
    expect(fields.find((f) => f.name === "status")).toMatchObject({ type: "enum", enumValues: ["open", "closed"] });
    expect(fields.find((f) => f.name === "tags")).toMatchObject({ type: "array", arrayElementType: "enum", enumValues: ["a", "b"] });
  });

  it("refuses a field typed with a union that mixes a value and a type: it names no type of the app", async () => {
    const result = await importTypeSpecDocumentAction('model Owner { email: string; }\nmodel Pet {\n  owner: Owner | "none";\n}\n');
    expect(result).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(!result.success && result.error.message).toBe('Model "Pet": field "owner" is typed "Owner | string", which is not a type of this app: use a TypeSpec standard type, an enum, a union or a model of the text.');
  });

  it("requires a session: nothing is compiled without one, or for a session whose user no longer exists", async () => {
    h.auth.mockResolvedValue(null);
    expect(await importTypeSpecDocumentAction(LEGIT)).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    h.auth.mockResolvedValue({ user: { id: "ghost" } });
    // The principal loader finds nobody for it (no such user, or a disabled one: tests/unit/lib/access/principal.test.ts).
    sessionPrincipalModule.getPrincipal.mockResolvedValueOnce(null);
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
