/**
 * Byte-identity guard (multi-entity emission, Task 4): the single-entity generator output was captured from the code as
 * it stood BEFORE the closure / pin-tag work. Whatever is added for closures must leave these exact strings unchanged.
 */
import { describe, it, expect } from "vitest";
import { compileEntity, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

const fld = (name: string, type: string, sortOrder: number, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder, ...extra,
});

const entity = (name: string, metadata: unknown = {}) => ({
  id: `e-${name}`, name, description: "An entity", status: "DRAFT", version: 1, domainId: null, metadata, domain: null,
});

const noRefs = compileEntity(entity("Customer", { tags: ["core", "pii"] }), [
  fld("id", "string", 0, { isKey: true, description: "Identifier" }),
  fld("email", "string", 1, { classification: "PII", decorators: { typespec: { validation: { maxLength: 80 } } } }),
  fld("age", "int32", 2, { nullable: true }),
  fld("tags", "array", 3, { decorators: { arrayElementType: "string" } }),
]);

const withRefs = compileEntity(entity("Order"), [
  fld("id", "string", 0, { isKey: true }),
  fld("customer", "reference", 1, { decorators: { referencedEntityName: "Customer" } }),
  fld("lines", "array", 2, { decorators: { arrayElementType: "reference", referencedEntityName: "Line Item" } }),
  fld("owner", "reference", 3, {
    decorators: {
      referencedEntityId: "e-Customer", referencedEntityName: "Customer",
      referencedQualifiedName: "sales/orders/Customer", referencedEntityVersion: "1.2",
    },
  }),
]);

// Added in fix round 1. Equality with the ORIGINAL generator (commit 1f27116, before this task) was proven for this exact
// model, governance on and off, by a temporary test importing `git show 1f27116:src/lib/compiler/typespec-generator.ts`
// (deleted afterwards); the snapshots below were then taken from the current code.
const shared = compileEntity(
  entity("Ticket", {
    custom: {
      namespace: "Support.Core",
      sharedEnums: [{ name: "Priority", values: ["low", "high"] }],
      customScalars: [{ name: "Money", baseType: "decimal" }],
      unionTypes: [{ name: "Ident", memberTypes: ["string", "int32"] }],
      aliases: [{ name: "Tags", type: "string[]" }],
    },
  }),
  [
    fld("state", "enum", 0, { aliases: ["open", "in-progress"] }),
    fld("key", "union", 1, { decorators: { unionName: "Ident" } }),
    fld("states", "array", 2, { decorators: { arrayElementType: "enum", enumValues: ["x", "y"] } }),
  ]
);

describe("stand-alone enum / shared type / union / alias shapes", () => {
  it("are unchanged, governance on and off", () => {
    expect(generateTypeSpec(shared)).toMatchSnapshot("shared governance");
    expect(generateTypeSpec(shared, { governance: false })).toMatchSnapshot("shared emission");
  });
});

describe("stand-alone generator output is byte-identical to the pre-closure generator", () => {
  it("entity without references, governance on and off", () => {
    expect(generateTypeSpec(noRefs)).toMatchSnapshot("no-refs governance");
    expect(generateTypeSpec(noRefs, { governance: false })).toMatchSnapshot("no-refs emission");
  });

  it("entity with references (unpinned and pinned), emission projection", () => {
    expect(generateTypeSpec(withRefs, { governance: false })).toMatchSnapshot("refs emission");
  });
});
