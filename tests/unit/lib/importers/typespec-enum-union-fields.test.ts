/**
 * The TypeSpec import reads a property typed with a name the document declares as what that name is: an enum (with its symbols, as the Avro
 * importer writes it), a union (with its members), an array with its element. Real @typespec/compiler, as the import runs it.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

vi.mock("server-only", () => ({}));

let compileTypeSpecDocument: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecDocument;
let mapDocumentToImportResult: typeof import("@/lib/importers/typespec.importer").mapDocumentToImportResult;

beforeAll(async () => {
  ({ compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler"));
  ({ mapDocumentToImportResult } = await import("@/lib/importers/typespec.importer"));
});

const SOURCE = `
enum OrderStatus { Open, Closed }
union Pet { cat: Cat, dog: Dog }
model Cat { lives: int32; }
model Dog { bark: string; }
model Order {
  id: string;
  status: OrderStatus;
  history: OrderStatus[];
  pet: Pet;
  tags: string[];
}
`;

async function importedOrder() {
  const result = mapDocumentToImportResult(await compileTypeSpecDocument(SOURCE), SOURCE);
  const order = result.models.find((m) => m.name === "Order");
  if (!order) throw new Error("the Order model was not imported");
  return Object.fromEntries(order.fields.map((f) => [f.name, f]));
}

describe("the TypeSpec import types a property by what its name declares", () => {
  it("a property typed with a declared enum is an enum field, with its symbols", async () => {
    const fields = await importedOrder();
    expect(fields.status).toMatchObject({ type: "enum", enumName: "OrderStatus", enumValues: ["Open", "Closed"] });
  });

  it("an array of a declared enum is an array whose element is an enum", async () => {
    const fields = await importedOrder();
    expect(fields.history).toMatchObject({ type: "array", arrayElementType: "enum", enumName: "OrderStatus", enumValues: ["Open", "Closed"] });
  });

  it("a property typed with a declared union is a union field, with its members and its name", async () => {
    const fields = await importedOrder();
    expect(fields.pet).toMatchObject({ type: "union", unionName: "Pet", unionMembers: ["Cat", "Dog"] });
  });

  it("an array of a standard type keeps its element type", async () => {
    const fields = await importedOrder();
    expect(fields.tags).toMatchObject({ type: "array", arrayElementType: "string" });
    expect(fields.id).toMatchObject({ type: "string" });
    expect(fields.id).not.toHaveProperty("enumName");
  });
});
