import { describe, it, expect, vi } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.setConfig({ testTimeout: 60_000 });
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Found by the corpus: an entity with a composite key (two @key fields) could not be generated as OpenAPI 3 at all:
// `@typespec/rest/duplicate-key: More than one key found on model type Line`. The OpenAPI source imported and used @typespec/rest, whose
// validator allows one @key per model; nothing in the generated source uses a rest decorator, and a composite key is a normal entity.
const entity: PrismaEntityInput = { id: "e", name: "OrderLine", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (name: string, type: string, isKey: boolean, i: number): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable: false, isKey, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: i,
});

describe("OpenAPI 3 generation of an entity with a composite key", () => {
  it("compiles and lists every field", async () => {
    const fields = [field("orderId", "string", true, 0), field("lineNo", "int32", true, 1), field("qty", "int32", false, 2)];
    const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "openapi3");
    expect(result.errors).toEqual([]);
    expect(result.validationStatus).not.toBe("INVALID");
    for (const name of ["orderId", "lineNo", "qty"]) expect(result.output).toContain(name);
  });
});
