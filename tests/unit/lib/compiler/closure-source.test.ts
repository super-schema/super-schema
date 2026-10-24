import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { qualifiedName, writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { generateClosureTypeSpec, uniqueModelName } from "@/lib/compiler/closure-source";

// Real @typespec/compiler compiles (~1 s each).
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;
beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

const field = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown> = {}, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder, ...extra,
});

const refTo = (target: EntityRef & { entityId: string }) =>
  writeFieldReference({}, target) as Record<string, unknown>;

function member(id: string, domain: string, product: string, entity: string, fields: PrismaFieldInput[], metadata: unknown = {}): ClosureEntity {
  const ref: EntityRef = { entityId: id, domain, product, entity };
  return {
    entityId: id,
    ref,
    source: "published",
    version: "1.0",
    fields: [field("id", "uuid", 0, {}, { isKey: true }), ...fields],
    entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata, domain: null },
  };
}

async function expectCompiles(source: string) {
  const result = await compileTypeSpecWithGovernance(source);
  if (!result.success) throw new Error(`does not compile:\n${JSON.stringify(result.diagnostics, null, 1)}\n${source}`);
}

describe("compile helper sanity", () => {
  it("rejects a source that references an undeclared model", async () => {
    await expect(expectCompiles("model A { b: Nope.Missing; }")).rejects.toThrow(/does not compile/);
  });
});

describe("uniqueModelName", () => {
  it("is deterministic and readable for plain segments", () => {
    const ref = { domain: "Sales", product: "Orders", entity: "Order" };
    expect(uniqueModelName(ref)).toBe("Sales_Orders_Order");
    expect(uniqueModelName(ref)).toBe(uniqueModelName({ ...ref }));
  });

  it("keeps the tenant placeholder readable and valid", () => {
    expect(uniqueModelName({ domain: "_tenant", product: "_tenant", entity: "Order" })).toBe("_tenant__tenant_Order");
  });

  it("never merges two distinct refs that sanitize alike (hash suffix only then)", () => {
    const a = uniqueModelName({ domain: "a-b", product: "c", entity: "X" });
    const b = uniqueModelName({ domain: "a_b", product: "c", entity: "X" });
    const c = uniqueModelName({ domain: "a", product: "b_c", entity: "X" });
    expect(new Set([a, b, c]).size).toBe(3);
    for (const n of [a, b, c]) expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(a).toMatch(/^a_b_c_X_[0-9a-f]{8}$/);
  });

  it("produces a valid identifier for hostile and reserved-word segments", () => {
    for (const ref of [
      { domain: "model", product: "enum", entity: "namespace" },
      { domain: "日本語", product: "1abc", entity: "__proto__" },
      { domain: "", product: " ", entity: "`x`" },
    ]) {
      expect(uniqueModelName(ref)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});

describe("generateClosureTypeSpec", () => {
  const customerSales = member("c1", "Sales", "Orders", "Customer", []);
  const customerSupport = member("c2", "Support", "Tickets", "Customer", []);
  const order = member("o1", "Sales", "Orders", "Order", [
    field("buyer", "reference", 1, refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer" })),
    field("agent", "reference", 2, refTo({ entityId: "c2", domain: "Support", product: "Tickets", entity: "Customer" })),
  ]);

  it("gives same-named entities in different products distinct namespaces and model names, and types references with the qualified model", async () => {
    const out = generateClosureTypeSpec({ entities: [order, customerSales, customerSupport] }, { target: "json-schema" });
    expect(out.rootModel).toBe("Sales_Orders_Order");
    expect(out.models.get("c1")).toBe("SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer");
    expect(out.models.get("c2")).toBe("SuperSchemaClosure.Support.Tickets.Customer.Support_Tickets_Customer");
    expect(out.source).toContain("namespace SuperSchemaClosure.Sales.Orders.Customer {");
    expect(out.source).toContain("namespace SuperSchemaClosure.Support.Tickets.Customer {");
    expect(out.source).toContain("buyer: SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer;");
    expect(out.source).toContain("agent: SuperSchemaClosure.Support.Tickets.Customer.Support_Tickets_Customer;");
    expect(new Set(out.models.values()).size).toBe(3);
    await expectCompiles(out.source);
  });

  it("emits arrays and maps of references qualified, and an unresolvable one as unknown", async () => {
    const root = member("o1", "Sales", "Orders", "Order", [
      field("buyers", "array", 1, { arrayElementType: "reference", ...refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer" }) }),
      field("byName", "map", 2, { mapValueType: "reference", ...refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer" }) }),
      field("ghost", "reference", 3, refTo({ entityId: "gone", domain: "X", product: "Y", entity: "Ghost" })),
      field("legacy", "reference", 4, { referencedEntityName: "customer" }),
      field("legacyGhost", "array", 5, { arrayElementType: "reference", referencedEntityName: "Nope" }),
    ]);
    const out = generateClosureTypeSpec({ entities: [root, customerSales] }, { target: "avro" });
    expect(out.source).toContain("buyers: SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer[];");
    expect(out.source).toContain("byName: Record<SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer>;");
    expect(out.source).toContain("ghost: unknown;");
    expect(out.source).toContain("legacy: SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer;");
    expect(out.source).toContain("legacyGhost: unknown[];");
    await expectCompiles(out.source);
  });

  it("compiles a self-reference and an A <-> B cycle with the real compiler", async () => {
    const a = member("a", "D", "P", "A", [
      field("self", "reference", 1, refTo({ entityId: "a", domain: "D", product: "P", entity: "A" })),
      field("other", "reference", 2, refTo({ entityId: "b", domain: "D", product: "P", entity: "B" })),
    ]);
    const b = member("b", "D", "P", "B", [field("back", "reference", 1, refTo({ entityId: "a", domain: "D", product: "P", entity: "A" }))]);
    const out = generateClosureTypeSpec({ entities: [a, b] }, { target: "json-schema" });
    expect(out.source).toContain("self: SuperSchemaClosure.D.P.A.D_P_A;");
    expect(out.source).toContain("back: SuperSchemaClosure.D.P.A.D_P_A;");
    await expectCompiles(out.source);
  });

  it("compiles hostile names: reserved words, merged sanitized names, an Enterprise segment, inline enums", async () => {
    const entities = [
      member("1", "model", "enum", "union", [field("kind", "enum", 1, {}, { aliases: ["a", "b"] })]),
      member("2", "a-b", "c", "X", [field("p", "reference", 1, refTo({ entityId: "3", domain: "a_b", product: "c", entity: "X" }))]),
      member("3", "a_b", "c", "X", [field("q", "reference", 1, refTo({ entityId: "1", domain: "model", product: "enum", entity: "union" }))]),
      member("4", "Enterprise", "P", "Enterprise", [field("c", "string", 1, {}, { classification: "PII" })]),
    ];
    const out = generateClosureTypeSpec({ entities }, { target: "json-schema", governance: true });
    expect(new Set(out.models.values()).size).toBe(4);
    await expectCompiles(out.source);
  });

  it("disambiguates two closure members that share a qualified name", async () => {
    const one = member("x1", "D", "P", "Same", []);
    const two = member("x2", "D", "P", "Same", []);
    const out = generateClosureTypeSpec({ entities: [one, two] }, { target: "avro" });
    expect(qualifiedName(one.ref)).toBe(qualifiedName(two.ref));
    expect(new Set(out.models.values()).size).toBe(2);
    await expectCompiles(out.source);
  });

  it("never writes the pin tag in the emission projection, and keeps it when governance is on", () => {
    const root = member("o1", "Sales", "Orders", "Order", [
      field("buyer", "reference", 1, refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer", pinnedVersion: "1.2" })),
    ]);
    const emission = generateClosureTypeSpec({ entities: [root, customerSales] }, { target: "json-schema" });
    expect(emission.source).not.toContain("x-super-schema-pin");
    const canonical = generateClosureTypeSpec({ entities: [root, customerSales] }, { target: "json-schema", governance: true });
    expect(canonical.source).toContain('@TypeSpec.OpenAPI.extension("x-super-schema-pin", "1.2")');
  });

  it("adds the json-schema import only for that target, once, ahead of the namespaces", () => {
    const js = generateClosureTypeSpec({ entities: [customerSales] }, { target: "json-schema" });
    expect(js.source.startsWith('import "@typespec/json-schema";\n\nnamespace SuperSchemaClosure.Sales.Orders.Customer {')).toBe(true);
    const avro = generateClosureTypeSpec({ entities: [customerSales] }, { target: "avro" });
    expect(avro.source).not.toContain("import ");
  });
});

describe("closure namespace scoping (reserved root)", () => {
  const selfRef = (id: string, d: string, p: string, e: string) =>
    field("me", "reference", 1, refTo({ entityId: id, domain: d, product: p, entity: e }));
  const other = (id: string, d: string, p: string, e: string) =>
    field("other", "reference", 2, refTo({ entityId: id, domain: d, product: p, entity: e }));

  const cases: [string, [string, string, string], [string, string, string]][] = [
    ["domain == product", ["Billing", "Billing", "Invoice"], ["Billing", "Billing", "Customer"]],
    ["product == entity", ["Billing", "Ledger", "Ledger"], ["Billing", "Ledger", "Customer"]],
    ["domain == entity", ["Billing", "Ledger", "Billing"], ["Billing", "Ledger", "Customer"]],
    ["domain == product == entity", ["Billing", "Billing", "Billing"], ["Billing", "Billing", "Customer"]],
    ["entity named like the root", ["Billing", "Ledger", "SuperSchemaClosure"], ["Billing", "Ledger", "Customer"]],
    ["domain named like the root", ["SuperSchemaClosure", "SuperSchemaClosure", "SuperSchemaClosure"], ["SuperSchemaClosure", "Ledger", "Customer"]],
  ];
  for (const [label, a, b] of cases) {
    it(`compiles with ${label}, in both directions`, async () => {
      const x = member("x", ...a, [other("y", ...b), selfRef("x", ...a)]);
      const y = member("y", ...b, [other("x", ...a)]);
      const out = generateClosureTypeSpec({ entities: [x, y] }, { target: "json-schema" });
      expect(new Set(out.models.values()).size).toBe(2);
      await expectCompiles(out.source);
    });
  }
});

describe("closure shared types", () => {
  const shared = {
    custom: {
      sharedEnums: [{ name: "Status", values: ["a", "b"] }],
      customScalars: [{ name: "Money", baseType: "decimal" }],
      unionTypes: [{ name: "Ident", memberTypes: ["string", "int32"] }],
      aliases: [{ name: "Tags", type: "string[]" }],
    },
  };
  const withShared = (id: string, entity: string) =>
    member(id, "D", "P", entity, [field("key", "union", 2, { unionName: "Ident" })], shared);

  it("declares each entity's shared types under distinct names that the entity's fields use, and compiles", async () => {
    const out = generateClosureTypeSpec({ entities: [withShared("a", "A"), withShared("b", "B")] }, { target: "json-schema" });
    const declared = [...out.source.matchAll(/^\s*(?:enum|scalar|union|alias) (\w+)/gm)].map((m) => m[1]);
    expect(declared).toEqual(expect.arrayContaining(["D_P_A_Status", "D_P_A_Money", "D_P_A_Ident", "D_P_A_Tags", "D_P_B_Status", "D_P_B_Money", "D_P_B_Ident", "D_P_B_Tags"]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(out.source).toContain("key: D_P_A_Ident;");
    expect(out.source).toContain("key: D_P_B_Ident;");
    await expectCompiles(out.source);
  });
});

describe("closure reference typing gate", () => {
  it("types a reference that has only a qualified name (no referencedEntityName), scalar and array", async () => {
    const target = member("c1", "Sales", "Orders", "Customer", []);
    const root = member("o1", "Sales", "Orders", "Order", [
      field("scalarQ", "reference", 1, { referencedQualifiedName: "Sales/Orders/Customer" }),
      field("byQualified", "array", 2, { arrayElementType: "reference", referencedQualifiedName: "Sales/Orders/Customer" }),
    ]);
    const out = generateClosureTypeSpec({ entities: [root, target] }, { target: "avro" });
    expect(out.source).toContain("byQualified: SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer[];");
    expect(out.source).toContain("scalarQ: SuperSchemaClosure.Sales.Orders.Customer.Sales_Orders_Customer;");
    await expectCompiles(out.source);
  });
});

describe("closure emission hooks (namespaces, declarations, unresolved references, merged namespaces)", () => {
  const sharedTypes = { custom: { sharedEnums: [{ name: "Status", values: ["a", "b"] }], aliases: [{ name: "Tags", type: "string[]" }] } };

  it("reports each entity's namespace and every top-level name its block declares", () => {
    const a = member("a", "D", "P", "A", [field("kind", "enum", 1, {}, { aliases: ["x", "y"] })], sharedTypes);
    const b = member("b", "D", "P", "B", []);
    const out = generateClosureTypeSpec({ entities: [a, b] }, { target: "json-schema" });
    expect(out.namespaces.get("a")).toBe("SuperSchemaClosure.D.P.A");
    expect(out.namespaces.get("b")).toBe("SuperSchemaClosure.D.P.B");
    expect(out.declarations.get("a")).toEqual(expect.arrayContaining(["D_P_A", "D_P_A_Status", "D_P_A_Tags", "D_P_A_kind"]));
    expect(out.declarations.get("b")).toEqual(["D_P_B"]);
  });

  it("lists a reference whose target is not in the closure once per field, and nothing for a resolved one", () => {
    const root = member("o1", "Sales", "Orders", "Order", [
      field("ok", "reference", 1, refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer" })),
      field("ghost", "reference", 2, refTo({ entityId: "gone", domain: "X", product: "Y", entity: "Ghost" })),
      field("ghosts", "array", 3, { arrayElementType: "reference", referencedEntityName: "Nope" }),
    ]);
    const customer = member("c1", "Sales", "Orders", "Customer", []);
    const out = generateClosureTypeSpec({ entities: [root, customer] }, { target: "avro" });
    expect(out.unresolved).toEqual([
      { entityId: "o1", fieldName: "ghost", reference: "X/Y/Ghost" },
      { entityId: "o1", fieldName: "ghosts", reference: "Nope" },
    ]);
  });

  it("puts a merged group in the namespace of its first member, references written against it, and compiles", async () => {
    const a = member("a", "D", "P", "A", [field("peer", "reference", 1, refTo({ entityId: "b", domain: "D", product: "P", entity: "B" }))]);
    const b = member("b", "D", "P", "B", [field("peer", "reference", 1, refTo({ entityId: "a", domain: "D", product: "P", entity: "A" }))]);
    const c = member("c", "D", "P", "C", [field("a", "reference", 1, refTo({ entityId: "a", domain: "D", product: "P", entity: "A" }))]);
    const out = generateClosureTypeSpec({ entities: [c, a, b] }, { target: "protobuf", mergeNamespaces: [["a", "b"]] });
    expect(out.namespaces.get("b")).toBe("SuperSchemaClosure.D.P.A");
    expect(out.models.get("b")).toBe("SuperSchemaClosure.D.P.A.D_P_B");
    expect(out.source).toContain("peer: SuperSchemaClosure.D.P.A.D_P_B;");
    expect(out.source).toContain("namespace SuperSchemaClosure.D.P.C {");
    await expectCompiles(out.source);
  });

  it("ignores a merge group of one, and an id that is not in the closure", () => {
    const a = member("a", "D", "P", "A", []);
    const b = member("b", "D", "P", "B", []);
    const out = generateClosureTypeSpec({ entities: [a, b] }, { target: "avro", mergeNamespaces: [["a"], ["b", "nope"]] });
    expect(out.namespaces.get("a")).toBe("SuperSchemaClosure.D.P.A");
    expect(out.namespaces.get("b")).toBe("SuperSchemaClosure.D.P.B");
  });
});
