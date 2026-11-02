import { describe, expect, it } from "vitest";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";

// A union of literal values (`"a" | "b"`, `1 | 2`, `true | false`) names no type: the compiler reports its symbols (`literalValues`, each as
// its text) and no member name. The planner of a text write refuses it (its type text contains "|" and it names no member), and the import
// reads the symbols as an enum field.

const fieldsOf = async (text: string, model = "Order") => {
  const doc = await compileTypeSpecDocument(text);
  const m = doc.models.find((x) => x.name === model);
  if (!m) throw new Error(`no model ${model}`);
  return m.fields;
};

describe("a union of string values is read as its symbols, never as a type", () => {
  it("a union of two or more string values keeps its symbols, and its type text names no type", async () => {
    const [status] = await fieldsOf('model Order {\n  status: "open" | "closed";\n}\n');
    expect(status).toMatchObject({ name: "status", type: "string | string", literalValues: ["open", "closed"] });
    expect(status.unionMembers).toBeUndefined();
  });

  it("an array of a union of string values is an array whose element names no type, with the symbols", async () => {
    const [tags] = await fieldsOf('model Order {\n  tags: ("a" | "b")[];\n}\n');
    expect(tags).toMatchObject({ name: "tags", type: "array", arrayElementType: "string | string", literalValues: ["a", "b"] });
    expect(tags.unionMembers).toBeUndefined();
  });

  it("a nullable union of string values keeps the symbols and the nullable fact", async () => {
    const [status] = await fieldsOf('model Order {\n  status: "open" | "closed" | null;\n}\n');
    expect(status).toMatchObject({ type: "string | string", literalValues: ["open", "closed"], nullableType: true });
  });

  it("a union of numbers or of booleans keeps its values as their text (an OpenAPI inline enum of them still imports)", async () => {
    const [code, active] = await fieldsOf("model Order {\n  code: 1 | 2 | 3;\n  active: true | false;\n}\n");
    expect(code).toMatchObject({ name: "code", literalValues: ["1", "2", "3"] });
    expect(active).toMatchObject({ name: "active", literalValues: ["true", "false"] });
  });

  it("a single string value is a string (not an enum of one), as it always was", async () => {
    const [kind] = await fieldsOf('model Order {\n  kind: "open";\n}\n');
    expect(kind).toMatchObject({ type: "string" });
    expect(kind.literalValues).toBeUndefined();
  });

  it("an array of a union that mixes a value and a type names no type of the app: its element is the union's text, with no member list", async () => {
    const fields = await fieldsOf('model Owner { email: string; }\nmodel Order {\n  owners: (Owner | "none")[];\n}\n');
    const owners = fields.find((f) => f.name === "owners");
    expect(owners).toMatchObject({ type: "array", arrayElementType: "Owner | string" });
    expect(owners?.unionMembers).toBeUndefined();
    expect(owners?.literalValues).toBeUndefined();
  });

  it("a union of model types keeps its member names, as it always did", async () => {
    const [pet] = await fieldsOf("model Cat { a: string; }\nmodel Dog { b: string; }\nmodel Order {\n  pet: Cat | Dog;\n}\n");
    expect(pet).toMatchObject({ name: "pet", type: "Cat | Dog", unionMembers: ["Cat", "Dog"] });
    expect(pet.literalValues).toBeUndefined();
  });
});

describe("an enum of numeric or boolean symbols, written as the generator writes it, compiles back", () => {
  it("quoted enum members named by digits and by true / false compile as an enum the field is typed with", async () => {
    const doc = await compileTypeSpecDocument('enum Order_code {\n  "1",\n  "2",\n}\nenum Order_active {\n  "true",\n  "false",\n}\nmodel Order {\n  code: Order_code;\n  active: Order_active;\n}\n');
    const fields = doc.models.find((x) => x.name === "Order")?.fields ?? [];
    expect(fields).toMatchObject([
      { name: "code", type: "Order_code" },
      { name: "active", type: "Order_active" },
    ]);
    expect(doc.enums?.map((e) => e.values)).toEqual([
      ["1", "2"],
      ["true", "false"],
    ]);
  });
});
