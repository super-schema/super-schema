/**
 * Compatibility with the generator as it was before wire names were preserved (final review F5, I1): an ORDINARY name —
 * and every TypeSpec reserved-for-future word, which compiles bare — produces byte-identical output, so published schema
 * names (`$id: Ticket_context.json`, Avro enum names) and the generated text of every existing entity do not change.
 * The only differences are the deliberate wire-name fixes (a hard keyword is quoted instead of mangled).
 *
 * `BASE_TICKET` was captured from the BASE generator (`git show 35000313:src/lib/compiler/typespec-generator.ts`).
 */
import { describe, it, expect } from "vitest";
import { compileEntity } from "@/lib/compiler/compiler.service";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { TYPESPEC_RESERVED_FUTURE_WORDS, generateTypeSpec, propertyName, sanitizeIdentifier, sanitizeIdentifierSegment } from "@/lib/compiler/typespec-generator";

const entity = (name: string, over: Partial<PrismaEntityInput> = {}): PrismaEntityInput => ({
  id: "e1",
  name,
  description: "",
  status: "DRAFT",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "Sales", slug: "sales" },
  ...over,
});

let seq = 0;
const field = (name: string, type = "string", over: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f${seq}`,
  name,
  type,
  precision: null,
  scale: null,
  nullable: false,
  isKey: false,
  fieldNumber: ++seq,
  description: "",
  classification: null,
  aliases: [],
  decorators: {},
  sortOrder: seq,
  ...over,
});

const generate = (e: PrismaEntityInput, fields: PrismaFieldInput[]) => generateTypeSpec(compileEntity(e, fields), { governance: false });

const BASE_TICKET = `@doc("Where it came from")
enum Ticket_context {
  OPEN,
  CLOSED,
}

enum Ticket_status {
  ACTIVE,
  INACTIVE,
  public,
  context,
}

enum Ticket__model {
  A,
  B,
}

@doc("A support ticket")
model Ticket {
  @key
  @doc("Ticket id")
  id: string;
  createdAt: utcDateTime;
  first_name?: string;
  metadata: string;
  @doc("Where it came from")
  context: Ticket_context;
  status: Ticket_status;
  _model: Ticket__model;
  tags: string[];
  attrs: Record<int32>;
  @minValue(0)
  @maxValue(10)
  score: int32;
}
`;

const ticketFields = (): PrismaFieldInput[] => [
  field("id", "string", { isKey: true, description: "Ticket id" }),
  field("createdAt", "utcDateTime"),
  field("first_name", "string", { nullable: true }),
  field("metadata", "string"),
  field("context", "enum", { aliases: ["OPEN", "CLOSED"], description: "Where it came from" }),
  field("status", "enum", { decorators: { typespec: { validation: { pattern: "ACTIVE|INACTIVE|public|context" } } } }),
  field("model", "enum", { aliases: ["A", "B"] }),
  field("tags", "array", { decorators: { arrayElementType: "string" } }),
  field("attrs", "map", { decorators: { mapKeyType: "string", mapValueType: "int32" } }),
  field("score", "int32", { decorators: { typespec: { validation: { minValue: 0, maxValue: 10 } } } }),
];

describe("generator output vs the base generator", () => {
  it("is byte-identical for ordinary names, reserved-future words and composite enum type names", () => {
    const out = generate(entity("Ticket", { description: "A support ticket" }), ticketFields());
    // the ONE deliberate difference: the hard keyword `model` keeps its wire name (the base mangled it to `_model`)
    expect(out).toBe(BASE_TICKET.replace("  _model: Ticket__model;", "  `model`: Ticket__model;"));
  });

  it("the composite inline enum TYPE name is unchanged for reserved-future words (Ticket_context, not Ticket__context)", () => {
    const out = generate(entity("Ticket"), [
      field("context", "enum", { aliases: ["A"] }),
      field("public", "enum", { aliases: ["B"] }),
      field("internal", "enum", { aliases: ["C"] }),
    ]);
    expect(out).toContain("enum Ticket_context {");
    expect(out).toContain("enum Ticket_public {");
    expect(out).toContain("enum Ticket_internal {");
    expect(out).toContain("  context: Ticket_context;");
    expect(out).not.toContain("Ticket__context");
    expect(out).not.toContain("Ticket__public");
  });

  it("keeps the base's `_` segment for the 15 historical keywords (type names it already published)", () => {
    const out = generate(entity("Ticket"), [field("model", "enum", { aliases: ["A"] }), field("op", "enum", { aliases: ["B"] })]);
    expect(out).toContain("enum Ticket__model {");
    expect(out).toContain("enum Ticket__op {");
    // ... while the property keeps its wire name
    expect(out).toContain("  `model`: Ticket__model;");
    expect(out).toContain("  `op`: Ticket__op;");
  });

  describe.each([...TYPESPEC_RESERVED_FUTURE_WORDS].filter((w) => w !== "extern"))("reserved-for-future word %s", (word) => {
    it("is a bare property name, exactly as the base emitted it", () => {
      expect(generate(entity("R"), [field(word)])).toBe(`model R {\n  ${word}: string;\n}\n`);
    });

    it("is a bare enum member, exactly as the base emitted it", () => {
      expect(generate(entity("R"), [field("e", "enum", { aliases: [word] })])).toBe(
        `enum R_e {\n  ${word},\n}\n\nmodel R {\n  e: R_e;\n}\n`
      );
    });
  });

  it("`extern` is the one reserved-future word whose output changed: the base mangled the wire name to `_extern`", () => {
    expect(generate(entity("R"), [field("extern")])).toBe("model R {\n  extern: string;\n}\n");
    expect(generate(entity("R"), [field("e", "enum", { aliases: ["extern"] })])).toContain("  extern,");
  });

  it("one rule set, three questions: type names, composite-name segments and wire names", () => {
    // a model / enum NAME: every keyword fails bare -> prefixed
    expect(sanitizeIdentifier("context")).toBe("_context");
    expect(sanitizeIdentifier("record")).toBe("_record");
    // the field segment of `<Entity>_<field>`: only the historical 15 words
    expect(sanitizeIdentifierSegment("context")).toBe("context");
    expect(sanitizeIdentifierSegment("model")).toBe("_model");
    expect(sanitizeIdentifierSegment("extern")).toBe("_extern");
    expect(sanitizeIdentifierSegment("in-progress")).toBe("in_progress");
    expect(sanitizeIdentifierSegment("2nd")).toBe("_2nd");
    // a model PROPERTY: only the hard keywords are quoted
    expect(propertyName("context")).toBe("context");
    expect(propertyName("op")).toBe("`op`");
  });
});
