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

function member(id: string, domain: string, product: string, entity: string, fields: PrismaFieldInput[]): ClosureEntity {
  const ref: EntityRef = { entityId: id, domain, product, entity };
  return {
    entityId: id,
    ref,
    source: "published",
    version: "1.0",
    fields: [field("id", "uuid", 0, {}, { isKey: true }), ...fields],
    entity: { id, name: entity, description: "", status: "PUBLISHED", version: 1, domainId: null, metadata: {}, domain: null },
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
    expect(out.models.get("c1")).toBe("Sales.Orders.Customer.Sales_Orders_Customer");
    expect(out.models.get("c2")).toBe("Support.Tickets.Customer.Support_Tickets_Customer");
    expect(out.source).toContain("namespace Sales.Orders.Customer {");
    expect(out.source).toContain("namespace Support.Tickets.Customer {");
    expect(out.source).toContain("buyer: Sales.Orders.Customer.Sales_Orders_Customer;");
    expect(out.source).toContain("agent: Support.Tickets.Customer.Support_Tickets_Customer;");
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
    expect(out.source).toContain("buyers: Sales.Orders.Customer.Sales_Orders_Customer[];");
    expect(out.source).toContain("byName: Record<Sales.Orders.Customer.Sales_Orders_Customer>;");
    expect(out.source).toContain("ghost: unknown;");
    expect(out.source).toContain("legacy: Sales.Orders.Customer.Sales_Orders_Customer;");
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
    expect(out.source).toContain("self: D.P.A.D_P_A;");
    expect(out.source).toContain("back: D.P.A.D_P_A;");
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
    expect(js.source.startsWith('import "@typespec/json-schema";\n\nnamespace Sales.Orders.Customer {')).toBe(true);
    const avro = generateClosureTypeSpec({ entities: [customerSales] }, { target: "avro" });
    expect(avro.source).not.toContain("import ");
  });
});
