/**
 * OpenAPI import via the official @typespec/openapi3 converter + the real
 * @typespec/compiler. Runs an actual conversion + compile in Node, so it
 * verifies the end-to-end path (not a mock of the converter).
 *
 * Final-review D-I1: the action is authenticated, size-capped, time-bounded and never echoes raw
 * compiler / host text (see the "guards" block at the end).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ auth: vi.fn(), resolveCurrentUserId: vi.fn() }));

// server-only throws outside an RSC bundle; neutralize it for the Node test
// (transitively imported via typespec-compiler.ts).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
// The real compiler stays behind a spy so the guards can be proven to run BEFORE it.
vi.mock("@/lib/compiler/typespec-compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compiler/typespec-compiler")>();
  return { ...actual, compileTypeSpecDocument: vi.fn(actual.compileTypeSpecDocument) };
});

import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { MAX_IMPORT_CONTENT_BYTES, IMPORT_COMPILE_TIMEOUT_MS } from "@/lib/compiler/import-limits";
import { TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import { AuditUserMissingError } from "@/lib/audit";

let importOpenApiDocumentAction: typeof import("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions").importOpenApiDocumentAction;

beforeAll(async () => {
  ({ importOpenApiDocumentAction } = await import(
    "@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions"
  ));
});

beforeEach(() => {
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.resolveCurrentUserId.mockResolvedValue("u1");
});

const PETSTORE_JSON = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "A pet",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          age: { type: "integer" },
        },
      },
    },
  },
});

const PETSTORE_YAML = `
openapi: "3.0.0"
info:
  title: Petstore
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: A list of pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      required: [id]
      properties:
        id:
          type: string
`;

describe("OpenAPI import action (real converter + compiler)", () => {
  it("imports an entity and an operation from an OpenAPI JSON document", async () => {
    const result = await importOpenApiDocumentAction(PETSTORE_JSON);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const petModel = result.data.models.find((m) => m.name === "Pet");
    expect(petModel).toBeDefined();
    const fieldNames = petModel!.fields.map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(["id", "name", "age"]));

    const allOps = result.data.services.flatMap((s) => s.operations);
    expect(allOps.some((op) => op.name === "getPet")).toBe(true);
    // Story 15.8: assets record that they came from OpenAPI, not TypeSpec.
    expect(result.data.sourceFormat).toBe("openapi");
  });

  it("imports an entity and operation from an OpenAPI YAML document", async () => {
    const result = await importOpenApiDocumentAction(PETSTORE_YAML);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.models.some((m) => m.name === "Pet")).toBe(true);
    const allOps = result.data.services.flatMap((s) => s.operations);
    expect(allOps.length).toBeGreaterThan(0);
  });

  it("rejects empty content", async () => {
    const result = await importOpenApiDocumentAction("");
    expect(result.success).toBe(false);
  });

  it("rejects invalid YAML/JSON", async () => {
    const result = await importOpenApiDocumentAction("{ not: valid: yaml: : :");
    expect(result.success).toBe(false);
  });
});

describe("OpenAPI import action guards (final-review D-I1)", () => {
  const GENERIC = "Something went wrong. Try again; if it keeps happening, contact an administrator.";
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(compileTypeSpecDocument).mockClear();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it("requires a session: no session and a stale session never reach the converter or the compiler", async () => {
    h.auth.mockResolvedValue(null);
    expect(await importOpenApiDocumentAction(PETSTORE_JSON)).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    h.auth.mockResolvedValue({ user: { id: "ghost" } });
    h.resolveCurrentUserId.mockRejectedValue(new AuditUserMissingError("ghost"));
    // a session pointing at a user that no longer exists is "not authenticated" too
    expect(await importOpenApiDocumentAction(PETSTORE_JSON)).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    expect(compileTypeSpecDocument).not.toHaveBeenCalled();
  });

  it("refuses a document over the size cap with a VALIDATION_ERROR before parsing it", async () => {
    const huge = `openapi: "3.0.0"\n# ${"x".repeat(MAX_IMPORT_CONTENT_BYTES)}\n`;
    const result = await importOpenApiDocumentAction(huge);
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(!result.success && result.error.message).toContain("too large");
    expect(compileTypeSpecDocument).not.toHaveBeenCalled();
  });

  it("measures the cap in bytes, not characters", async () => {
    const multibyte = "é".repeat(MAX_IMPORT_CONTENT_BYTES / 2 + 1); // fewer characters than the cap, more bytes
    expect(multibyte.length).toBeLessThan(MAX_IMPORT_CONTENT_BYTES);
    expect(await importOpenApiDocumentAction(multibyte)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });

  it("gives up on a compile that outlives the timeout (the in-process compile itself cannot be cancelled)", async () => {
    vi.useFakeTimers();
    vi.mocked(compileTypeSpecDocument).mockImplementationOnce(() => new Promise(() => undefined));
    const pending = importOpenApiDocumentAction(PETSTORE_JSON);
    await vi.advanceTimersByTimeAsync(IMPORT_COMPILE_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ success: false, error: { code: "COMPILE_TIMEOUT" } });
  });

  it("never returns raw compiler / host text: the original error is logged, the caller gets the generic message", async () => {
    const secret = "ENOENT: no such file or directory, open '/Users/deploy/app/.typespec-work/job-x/main.tsp'";
    vi.mocked(compileTypeSpecDocument).mockRejectedValueOnce(new Error(secret));
    const result = await importOpenApiDocumentAction(PETSTORE_JSON);
    expect(result).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: GENERIC } });
    expect(JSON.stringify(result)).not.toContain("deploy");
    expect(consoleError.mock.calls.flat().join(" ")).toContain(".typespec-work");
  });

  it("reports a disallowed import as such (that message is ours, not raw compiler text)", async () => {
    vi.mocked(compileTypeSpecDocument).mockRejectedValueOnce(
      new TypeSpecImportGuardError({ code: "TYPESPEC_IMPORT_NOT_ALLOWED", message: 'import "/tmp/x.mjs" is not allowed; only @typespec/* libraries and @superschema/typespec-enterprise can be imported' })
    );
    const result = await importOpenApiDocumentAction(PETSTORE_JSON);
    expect(result).toMatchObject({ success: false, error: { code: "TYPESPEC_IMPORT_NOT_ALLOWED" } });
  });

  it("shows only the position of a YAML syntax error, not the parser's quote of the document", async () => {
    const result = await importOpenApiDocumentAction("a: b: c: SECRET-TOKEN");
    expect(result).toMatchObject({ success: false, error: { code: "PARSE_ERROR" } });
    expect(JSON.stringify(result)).not.toContain("SECRET-TOKEN");
  });
});
