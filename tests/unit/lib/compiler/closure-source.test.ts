import { describe, it, expect, vi, beforeAll } from "vitest";
import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity } from "@/lib/references/closure";
import { qualifiedName, writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { closureModelNames, generateClosureTypeSpec, uniqueModelName } from "@/lib/compiler/closure-source";

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

  it("names a model after its entity, qualifies ONLY the same-named ones (product first), and types references with the qualified model", async () => {
    const out = generateClosureTypeSpec({ entities: [order, customerSales, customerSupport] }, { target: "json-schema" });
    expect(out.rootModel).toBe("Order");
    expect(out.models.get("o1")).toBe("SuperSchemaClosure.Sales.Orders.Order.Order");
    expect(out.models.get("c1")).toBe("SuperSchemaClosure.Sales.Orders.Customer.Orders_Customer");
    expect(out.models.get("c2")).toBe("SuperSchemaClosure.Support.Tickets.Customer.Tickets_Customer");
    expect(out.source).toContain("namespace SuperSchemaClosure.Sales.Orders.Customer {");
    expect(out.source).toContain("namespace SuperSchemaClosure.Support.Tickets.Customer {");
    expect(out.source).toContain("buyer: SuperSchemaClosure.Sales.Orders.Customer.Orders_Customer;");
    expect(out.source).toContain("agent: SuperSchemaClosure.Support.Tickets.Customer.Tickets_Customer;");
    expect(new Set(out.models.values()).size).toBe(3);
    await expectCompiles(out.source);
  });

  it("a closure of one entity, with or without a self-reference, uses exactly the stand-alone names", async () => {
    const plain = generateClosureTypeSpec({ entities: [member("a", "Sales", "Orders", "Order status", [field("kind", "enum", 1, {}, { aliases: ["x", "y"] })], { custom: { sharedEnums: [{ name: "Status", values: ["a", "b"] }] } })] }, { target: "json-schema" });
    expect(plain.rootModel).toBe("Order_status");
    // the inline enum is `<Entity>_<field>` and the shared enum keeps its own name: both as the stand-alone generator writes them
    expect(plain.declarations.get("a")).toEqual(["Status", "Order_status_kind", "Order_status"]);
    const selfRef = generateClosureTypeSpec({ entities: [member("s", "D", "P", "Node", [field("parent", "reference", 1, refTo({ entityId: "s", domain: "D", product: "P", entity: "Node" }))])] }, { target: "avro" });
    expect(selfRef.rootModel).toBe("Node");
    expect(selfRef.source).toContain("parent: SuperSchemaClosure.D.P.Node.Node;");
    await expectCompiles(plain.source);
    await expectCompiles(selfRef.source);
  });

  it("a name does not change when an entity of the closure is added, unless it now collides", () => {
    const alone = generateClosureTypeSpec({ entities: [order] }, { target: "avro" });
    const withUnrelated = generateClosureTypeSpec({ entities: [order, member("x", "Other", "Area", "Invoice", [])] }, { target: "avro" });
    expect(withUnrelated.rootModel).toBe(alone.rootModel);
    expect(withUnrelated.rootModel).toBe("Order");
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
    expect(out.source).toContain("buyers: SuperSchemaClosure.Sales.Orders.Customer.Customer[];");
    expect(out.source).toContain("byName: Record<SuperSchemaClosure.Sales.Orders.Customer.Customer>;");
    expect(out.source).toContain("ghost: unknown;");
    expect(out.source).toContain("legacy: SuperSchemaClosure.Sales.Orders.Customer.Customer;");
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
    expect(out.source).toContain("self: SuperSchemaClosure.D.P.A.A;");
    expect(out.source).toContain("back: SuperSchemaClosure.D.P.A.A;");
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

  it("prefixes the shared types that two entities both declare with the entity's model name, uses them in the entity's fields, and compiles", async () => {
    const out = generateClosureTypeSpec({ entities: [withShared("a", "A"), withShared("b", "B")] }, { target: "json-schema" });
    const declared = [...out.source.matchAll(/^\s*(?:enum|scalar|union|alias) (\w+)/gm)].map((m) => m[1]);
    expect(declared).toEqual(expect.arrayContaining(["A_Status", "A_Money", "A_Ident", "A_Tags", "B_Status", "B_Money", "B_Ident", "B_Tags"]));
    expect(new Set(declared).size).toBe(declared.length);
    expect(out.source).toContain("key: A_Ident;");
    expect(out.source).toContain("key: B_Ident;");
    await expectCompiles(out.source);
  });

  it("prefixes only the shared types something else claims: a name only one entity declares keeps its stand-alone name", async () => {
    const onlyA = member("a", "D", "P", "A", [field("key", "union", 2, { unionName: "Ident" })], shared);
    const onlyB = member("b", "D", "P", "B", [], { custom: { sharedEnums: [{ name: "Status", values: ["x"] }] } });
    const out = generateClosureTypeSpec({ entities: [onlyA, onlyB] }, { target: "json-schema" });
    // `Status` is declared by both -> prefixed in both; `Money`, `Ident`, `Tags` only by A -> as the stand-alone generator writes them
    expect(out.declarations.get("a")).toEqual(expect.arrayContaining(["A_Status", "Money", "Ident", "Tags", "A"]));
    expect(out.declarations.get("b")).toEqual(["B_Status", "B"]);
    expect(out.source).toContain("key: Ident;");
    await expectCompiles(out.source);
  });

  it("prefixes a shared type that is called like another entity's model, so the file / class names stay distinct", async () => {
    const owner = member("a", "D", "P", "A", [], { custom: { sharedEnums: [{ name: "B", values: ["x"] }] } });
    const entityB = member("b", "D", "P", "B", []);
    const out = generateClosureTypeSpec({ entities: [owner, entityB] }, { target: "json-schema" });
    expect(out.declarations.get("a")).toEqual(["A_B", "A"]);
    expect(out.declarations.get("b")).toEqual(["B"]);
    await expectCompiles(out.source);
  });
});

describe("closureModelNames", () => {
  const ref = (domain: string, product: string, entity: string) => ({ domain, product, entity });

  it("is the sanitized entity name, as the stand-alone path writes it", () => {
    expect(closureModelNames([ref("Sales", "Orders", "Order")])).toEqual(["Order"]);
    expect(closureModelNames([ref("Sales", "Orders", "Order status"), ref("Sales", "Orders", "model")])).toEqual(["Order_status", "_model"]);
  });

  it("qualifies only the colliding entities: product first, the others keep their name", () => {
    expect(closureModelNames([ref("Sales", "Orders", "Customer"), ref("Support", "Tickets", "Customer"), ref("Sales", "Orders", "Order")])).toEqual([
      "Orders_Customer",
      "Tickets_Customer",
      "Order",
    ]);
  });

  it("goes on to the domain when the product does not tell them apart (same name, same product name, two domains)", () => {
    expect(closureModelNames([ref("Sales", "Orders", "Customer"), ref("Billing", "Orders", "Customer"), ref("Sales", "Tickets", "Customer")])).toEqual([
      "Sales_Orders_Customer",
      "Billing_Orders_Customer",
      "Tickets_Customer",
    ]);
  });

  it("is independent of the order, and keeps a name stable when an unrelated entity is added", () => {
    const refs = [ref("Sales", "Orders", "Customer"), ref("Billing", "Orders", "Customer"), ref("Support", "Tickets", "Customer"), ref("Sales", "Orders", "Order")];
    const names = closureModelNames(refs);
    const reversed = closureModelNames([...refs].reverse()).reverse();
    expect(reversed).toEqual(names);
    expect(closureModelNames([...refs, ref("X", "Y", "Invoice")]).slice(0, 4)).toEqual(names);
  });

  it("hashes only as the last resort, when sanitizing still merges two different references", () => {
    const names = closureModelNames([ref("a-b", "c", "X"), ref("a_b", "c", "X"), ref("a", "b_c", "X")]);
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    // `a-b` / `a_b` entities with the same product: entity names merge, product names merge, only the hash tells them apart
    const merged = closureModelNames([ref("d", "p", "a-b"), ref("d", "p", "a_b")]);
    expect(new Set(merged).size).toBe(2);
    expect(merged[0]).toMatch(/_[0-9a-f]{8}$/);
    // plain segments never need a hash
    for (const n of closureModelNames([ref("Sales", "Orders", "Customer"), ref("Billing", "Orders", "Customer")])) expect(n).not.toMatch(/_[0-9a-f]{8}$/);
  });

  it("never lets a qualified name take another entity's name", () => {
    const names = closureModelNames([ref("A", "Orders", "Customer"), ref("B", "Tickets", "Customer"), ref("C", "D", "Orders_Customer")]);
    expect(new Set(names).size).toBe(3);
  });

  it("does not use the reserved closure root, an empty name or a reserved name as it is", () => {
    expect(closureModelNames([ref("Billing", "Ledger", "SuperSchemaClosure")])).toEqual(["Ledger_SuperSchemaClosure"]);
    expect(closureModelNames([ref("Billing", "Ledger", "")])[0]).not.toBe("");
    expect(closureModelNames([ref("Sales", "Orders", "Sales"), ref("Sales", "Orders", "Order")], new Set(["Sales"]))).toEqual(["Orders_Sales", "Order"]);
  });

  it("keeps identical references on one name (the closure suffixes those by order)", () => {
    const names = closureModelNames([ref("D", "P", "Same"), ref("D", "P", "Same")]);
    expect(names[0]).toBe(names[1]);
  });
});

describe("closure model names compile with the real compiler", () => {
  const withRef = (id: string, d: string, p: string, e: string, to: Array<[string, string, string, string]>): ClosureEntity =>
    member(id, d, p, e, to.map(([tid, td, tp, te], i) => field(`r${i}`, "reference", i + 1, refTo({ entityId: tid, domain: td, product: tp, entity: te }))));

  it("the same entity name in two products", async () => {
    const out = generateClosureTypeSpec(
      {
        entities: [
          withRef("o", "Sales", "Orders", "Order", [["c1", "Sales", "Orders", "Customer"], ["c2", "Sales", "Tickets", "Customer"]]),
          member("c1", "Sales", "Orders", "Customer", []),
          member("c2", "Sales", "Tickets", "Customer", []),
        ],
      },
      { target: "json-schema" }
    );
    expect([...out.models.values()].map((m) => m.split(".").pop())).toEqual(["Order", "Orders_Customer", "Tickets_Customer"]);
    await expectCompiles(out.source);
  });

  it("the same entity name in two domains (same product name)", async () => {
    const out = generateClosureTypeSpec(
      {
        entities: [
          withRef("o", "Sales", "Orders", "Order", [["c1", "Sales", "Orders", "Customer"], ["c2", "Billing", "Orders", "Customer"]]),
          member("c1", "Sales", "Orders", "Customer", []),
          member("c2", "Billing", "Orders", "Customer", []),
        ],
      },
      { target: "json-schema" }
    );
    expect([...out.models.values()].map((m) => m.split(".").pop())).toEqual(["Order", "Sales_Orders_Customer", "Billing_Orders_Customer"]);
    await expectCompiles(out.source);
  });

  it("entity names that sanitize identically (`a-b` and `a_b` in one product)", async () => {
    const out = generateClosureTypeSpec(
      {
        entities: [
          withRef("o", "D", "P", "Root", [["x", "D", "P", "a-b"], ["y", "D", "P", "a_b"]]),
          member("x", "D", "P", "a-b", []),
          member("y", "D", "P", "a_b", []),
        ],
      },
      { target: "json-schema" }
    );
    const names = [...out.models.values()].map((m) => m.split(".").pop() as string);
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe("Root");
    await expectCompiles(out.source);
  });

  it("a Protobuf message is never called like a domain of the closure (protoc resolves the first name component innermost first)", async () => {
    const entities = [withRef("o", "Sales", "Orders", "Sales", [["c", "Sales", "Orders", "Customer"]]), member("c", "Sales", "Orders", "Customer", [])];
    expect(generateClosureTypeSpec({ entities }, { target: "protobuf" }).rootModel).toBe("Orders_Sales");
    expect(generateClosureTypeSpec({ entities }, { target: "json-schema" }).rootModel).toBe("Sales");
    await expectCompiles(generateClosureTypeSpec({ entities }, { target: "protobuf" }).source);
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
    expect(out.source).toContain("byQualified: SuperSchemaClosure.Sales.Orders.Customer.Customer[];");
    expect(out.source).toContain("scalarQ: SuperSchemaClosure.Sales.Orders.Customer.Customer;");
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
    expect(out.declarations.get("a")).toEqual(expect.arrayContaining(["A", "Status", "Tags", "A_kind"]));
    expect(out.declarations.get("b")).toEqual(["B"]);
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
    expect(out.models.get("b")).toBe("SuperSchemaClosure.D.P.A.B");
    expect(out.source).toContain("peer: SuperSchemaClosure.D.P.A.B;");
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
