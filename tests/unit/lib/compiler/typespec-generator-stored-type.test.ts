import { describe, expect, it } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecDocument, TypeSpecCompileError } from "@/lib/compiler/typespec-compiler";

// A stored field type is written into the TypeSpec text as the type it names. A row written before the writers refused non-app type names
// may hold any text: it must never become a second declaration of the text, only a name the compiler refuses.

const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };
const field = (name: string, type: string): PrismaFieldInput => ({
  id: name, name, type, precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null,
  aliases: [], decorators: {}, sortOrder: 0,
});
const source = (...fields: PrismaFieldInput[]) => generateTypeSpec(compileEntity(entity, fields), { governance: false });

describe("a stored field type that is not a plain name", () => {
  const INJECTED = "string; } model Injected { flag: boolean";

  it("is written as one quoted identifier: no second declaration appears in the text", () => {
    const text = source(field("note", INJECTED));
    expect(text).not.toMatch(/^model Injected/m);
    expect(text).toContain("note: `string; } model Injected { flag: boolean`;");
  });

  it("is refused by the compiler, with the text as an unknown identifier, instead of compiling", async () => {
    const text = source(field("note", INJECTED));
    await expect(compileTypeSpecDocument(text)).rejects.toBeInstanceOf(TypeSpecCompileError);
  }, 60_000);

  it("a plain stored type is written as it always was", () => {
    expect(source(field("note", "string"))).toContain("note: string;");
  });
});
