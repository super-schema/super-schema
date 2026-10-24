/**
 * Closure emission (multi-entity emission, Task 6): one file per entity on the five schema targets, compiled by the REAL
 * `tsp compile` through the existing emitter runner (about 1 s each).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// The real TypeSpec compiler / emitters run here; under load the 5 s default is too tight.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock("@/lib/db", () => ({ prisma: {} }));

import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import type { ClosureEntity, ReferenceClosure } from "@/lib/references/closure";
import { writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { supportsClosureEmission } from "@/lib/schema-targets/catalog";
import { bundleEmittedFiles, emitClosure, filesForEntity, type ClosureEmission, type EmittedFile } from "@/lib/typespec-official/closure-emit";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

const TARGETS = ["json-schema", "openapi3", "protobuf", "avro", "java-pojo"] as const;

const field = (name: string, type: string, sortOrder: number, decorators: Record<string, unknown> = {}, extra: Partial<PrismaFieldInput> = {}): PrismaFieldInput => ({
  id: `f-${name}`, name, type, precision: null, scale: null, nullable: false, isKey: false,
  fieldNumber: null, description: "", classification: null, aliases: [], decorators, sortOrder, ...extra,
});

const refTo = (target: EntityRef & { entityId: string }, extra: Partial<EntityRef> = {}) =>
  writeFieldReference({}, { ...target, ...extra }) as Record<string, unknown>;

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

function closureOf(entities: ClosureEntity[], cycles: string[][] = []): ReferenceClosure {
  return { root: entities[0], entities, draftEntities: [], cycles };
}

const ADDRESS: EntityRef & { entityId: string } = { entityId: "a", domain: "Sales", product: "Orders", entity: "Address" };
const CUSTOMER: EntityRef & { entityId: string } = { entityId: "c", domain: "Sales", product: "Orders", entity: "Customer" };

const address = () => member("a", "Sales", "Orders", "Address", [field("city", "string", 1), field("zip", "string", 2)]);
const customer = () => member("c", "Sales", "Orders", "Customer", [field("home", "reference", 1, refTo(ADDRESS))]);
const order = () =>
  member("o", "Sales", "Orders", "Order", [
    field("buyer", "reference", 1, refTo(CUSTOMER)),
    field("ship", "reference", 2, refTo(ADDRESS)),
  ]);
/** Order -> Customer -> Address, and Order -> Address: three entities, root first. */
const threeEntities = () => closureOf([order(), customer(), address()]);

const JAVAC_AVAILABLE = spawnSync("javac", ["-version"]).status === 0;

/** Writes the files under their paths and compiles them together with `javac`; the exit status is the verdict, stderr is for the failure message. */
function compileJava(files: EmittedFile[]): { status: number | null; stderr: string; classDirs: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "closure-javac-"));
  try {
    const sources: string[] = [];
    for (const f of files) {
      const full = path.join(dir, "src", f.path);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, f.content);
      sources.push(full);
    }
    const compiled = spawnSync("javac", ["-d", path.join(dir, "out"), ...sources], { encoding: "utf8" });
    return { status: compiled.status, stderr: compiled.stderr, classDirs: compiled.status === 0 ? readdirSync(path.join(dir, "out")) : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function emit(closure: ReferenceClosure, target: string): Promise<ClosureEmission> {
  const result = await emitClosure(closure, target);
  if (!result.success) throw new Error(`emitClosure(${target}) failed: ${result.error.code} ${result.error.message}`);
  return result.data;
}

const text = (files: EmittedFile[]) => files.map((f) => f.content).join("\n");
const byPath = (files: EmittedFile[], suffix: string): EmittedFile => {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no file ending in ${suffix}; got ${files.map((f) => f.path).join(", ")}`);
  return found;
};

describe("three-entity closure, one file per entity on every target", () => {
  const out = {} as Record<(typeof TARGETS)[number], ClosureEmission>;
  beforeAll(async () => {
    await Promise.all(TARGETS.map(async (target) => { out[target] = await emit(threeEntities(), target); }));
  });

  it.each(TARGETS)("%s: three files, tagged with the target, mapped to their entities, sorted by path", (target) => {
    const { files } = out[target];
    expect(files).toHaveLength(3);
    for (const f of files) expect(f.target).toBe(target);
    expect(files.map((f) => f.entityId).sort()).toEqual(["a", "c", "o"]);
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
    expect(new Set(files.map((f) => f.path)).size).toBe(3);
    expect(filesForEntity(files, "o")).toHaveLength(1);
  });

  it.each(TARGETS)("%s: the reserved closure root never reaches the output", (target) => {
    const { files } = out[target];
    expect(text(files)).not.toContain("SuperSchemaClosure");
    for (const f of files) expect(f.path).not.toContain("SuperSchemaClosure");
  });

  it("json-schema: Order.json points at the Address file with a native $ref, no bundle", () => {
    const { files } = out["json-schema"];
    expect(files.map((f) => f.path)).toEqual(["Address.json", "Customer.json", "Order.json"]);
    const orderFile = JSON.parse(byPath(files, "Order.json").content);
    expect(orderFile.properties.ship.$ref).toBe("Address.json");
    expect(orderFile.properties.buyer.$ref).toBe("Customer.json");
    expect(byPath(files, "Order.json").content).toContain('"$ref": "Address.json"');
    expect(text(files)).not.toContain("$defs");
  });

  it("openapi3: each entity gets its own @service file, referenced entities are inlined in components.schemas, no external ref", () => {
    const { files } = out.openapi3;
    expect(files.map((f) => f.path)).toEqual(["openapi.Sales.Orders.Address.yaml", "openapi.Sales.Orders.Customer.yaml", "openapi.Sales.Orders.Order.yaml"]);
    const doc = parseYaml(byPath(files, "openapi.Sales.Orders.Order.yaml").content) as { info: { title: string }; components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> } };
    expect(doc.info.title).toBe("Order");
    expect(Object.keys(doc.components.schemas).sort()).toEqual(["Address", "Customer", "Order"]);
    expect(doc.components.schemas.Order.properties?.ship.$ref).toBe("#/components/schemas/Address");
    for (const f of files) {
      const refs = [...f.content.matchAll(/\$ref:\s*'?([^'\n]+)'?/g)].map((m) => m[1]);
      for (const ref of refs) expect(ref.startsWith("#/")).toBe(true);
    }
    // the Address file is its own service and carries only Address
    const addressDoc = parseYaml(byPath(files, "openapi.Sales.Orders.Address.yaml").content) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(addressDoc.components.schemas)).toEqual(["Address"]);
  });

  it("protobuf: one package per entity from its qualified path, imports between the files", () => {
    const { files } = out.protobuf;
    expect(files.map((f) => f.path)).toEqual(["Sales/Orders/Address.proto", "Sales/Orders/Customer.proto", "Sales/Orders/Order.proto"]);
    const orderProto = byPath(files, "Sales/Orders/Order.proto").content;
    expect(orderProto).toContain("package Sales.Orders.Order;");
    expect(orderProto).toContain('import "Sales/Orders/Address.proto";');
    expect(orderProto).toContain('import "Sales/Orders/Customer.proto";');
    expect(orderProto).toContain("message Order");
    expect(byPath(files, "Sales/Orders/Address.proto").content).not.toContain("import ");
  });

  it("avro: Order's file holds Address inline once, then refers to it by full name, in the entity's own namespace", () => {
    const { files } = out.avro;
    expect(files.map((f) => f.path)).toEqual([
      "com.superschema.sales.orders.address.Address.avsc.json",
      "com.superschema.sales.orders.customer.Customer.avsc.json",
      "com.superschema.sales.orders.order.Order.avsc.json",
    ]);
    const orderSchema = JSON.parse(byPath(files, "Order.avsc.json").content);
    expect(orderSchema.namespace).toBe("com.superschema.sales.orders.order");
    const definitions: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "record" && record.name === "Address") definitions.push(record);
      Object.values(record).forEach(walk);
    };
    walk(orderSchema);
    expect(definitions).toHaveLength(1);
    const ship = orderSchema.fields.find((f: { name: string }) => f.name === "ship");
    expect(ship.type).toBe("com.superschema.sales.orders.address.Address");
  });

  it("java: the classes import each other across packages and live under their package directories", () => {
    const { files } = out["java-pojo"];
    expect(files.map((f) => f.path)).toEqual([
      "sales/orders/address/Address.java",
      "sales/orders/customer/Customer.java",
      "sales/orders/order/Order.java",
    ]);
    const orderJava = byPath(files, "Order.java").content;
    expect(orderJava).toContain("package sales.orders.order;");
    expect(orderJava).toContain("import sales.orders.address.Address;");
    expect(orderJava).toContain("import sales.orders.customer.Customer;");
  });

  it.skipIf(!JAVAC_AVAILABLE)("java: the set compiles with javac", () => {
    const compiled = compileJava(out["java-pojo"].files);
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(compiled.classDirs).toContain("sales");
  });

  it("every entity is served by exactly its own file(s) (entityFiles)", () => {
    for (const target of TARGETS) {
      const { files, entityFiles } = out[target];
      expect(Object.keys(entityFiles).sort()).toEqual(["a", "c", "o"]);
      for (const id of ["a", "c", "o"]) expect(entityFiles[id]).toEqual(filesForEntity(files, id).map((f) => f.path));
    }
  });

  it.each(TARGETS)("%s: running it again gives the same files in the same order", async (target) => {
    const again = await emit(threeEntities(), target);
    expect(again).toEqual(out[target]);
  });

  it.each(TARGETS)("%s: the bundled output lists every file", (target) => {
    const { files } = out[target];
    const bundled = bundleEmittedFiles(files);
    for (const f of files) expect(bundled).toContain(`===== ${f.path} =====`);
  });
});

describe("entities with enums and shared types", () => {
  const sharedTypes = { custom: { sharedEnums: [{ name: "Status", values: ["open", "closed"] }], aliases: [{ name: "Tags", type: "string[]" }] } };
  const closure = () =>
    closureOf([
      order(),
      customer(),
      member("a", "Sales", "Orders", "Address", [field("city", "string", 1), field("kind", "enum", 2, {}, { aliases: ["home", "in-progress"] })], sharedTypes),
    ]);

  it.each(TARGETS)("%s: emits one set per entity; every file is mapped to its entity where the target names files after declarations", async (target) => {
    const { files, warnings } = await emit(closure(), target);
    expect(text(files)).not.toContain("SuperSchemaClosure");
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    if (target === "json-schema") {
      // the model, the inline enum and the shared enum of Address are each a file, all attributed to Address
      expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(["Address.json", "Address_kind.json", "Status.json"]));
      for (const f of files) expect(f.entityId).toBeDefined();
      expect(filesForEntity(files, "a").length).toBeGreaterThanOrEqual(3);
    } else if (target === "java-pojo") {
      // a class per model plus a class per enum, in the entity's package directory
      expect(files).toHaveLength(5);
      for (const f of files) expect(f.entityId).toBeDefined();
      expect(filesForEntity(files, "a").map((f) => f.path)).toEqual([
        "sales/orders/address/Address.java",
        "sales/orders/address/AddressKind.java",
        "sales/orders/address/Status.java",
      ]);
    } else {
      expect(files).toHaveLength(3);
      expect(files.map((f) => f.entityId).sort()).toEqual(["a", "c", "o"]);
    }
    if (target === "avro") expect(warnings.some((w) => w.includes("in-progress") && w.includes("in_progress"))).toBe(true);
  });
});

describe("names: after the entity, qualified only where entities collide", () => {
  const customerIn = (id: string, d: string, p: string) => member(id, d, p, "Customer", [field("name", "string", 1)]);
  const toCustomer = (id: string, d: string, p: string) => refTo({ entityId: id, domain: d, product: p, entity: "Customer" });

  it("an entity keeps the name it has stand-alone when it gains references (Order.json, message Order, class Order)", async () => {
    const solo = closureOf([member("o", "Sales", "Orders", "Order", [field("note", "string", 1)])]);
    const withRefs = closureOf([order(), customer(), address()]);
    expect((await emit(solo, "json-schema")).files.map((f) => f.path)).toEqual(["Order.json"]);
    expect((await emit(withRefs, "json-schema")).files.map((f) => f.path)).toContain("Order.json");
    expect(byPath((await emit(withRefs, "protobuf")).files, "Order.proto").content).toContain("message Order {");
    expect(byPath((await emit(withRefs, "java-pojo")).files, "Order.java").content).toContain("public class Order {");
  });

  describe("the same entity name in two products", () => {
    const closure = () =>
      closureOf([
        member("o", "Sales", "Orders", "Order", [field("buyer", "reference", 1, toCustomer("c1", "Sales", "Orders")), field("agent", "reference", 2, toCustomer("c2", "Support", "Tickets"))]),
        customerIn("c1", "Sales", "Orders"),
        customerIn("c2", "Support", "Tickets"),
      ]);

    it.each(TARGETS)("%s: three distinct files, one per entity", async (target) => {
      const { files } = await emit(closure(), target);
      expect(files).toHaveLength(3);
      expect(new Set(files.map((f) => f.path)).size).toBe(3);
      expect(files.map((f) => f.entityId).sort()).toEqual(["c1", "c2", "o"]);
    });

    it("json-schema: only the two Customers are qualified (product first), Order keeps its name, each $ref points at the right file", async () => {
      const { files } = await emit(closure(), "json-schema");
      expect(files.map((f) => f.path)).toEqual(["Order.json", "Orders_Customer.json", "Tickets_Customer.json"]);
      const orderSchema = JSON.parse(byPath(files, "Order.json").content);
      expect(orderSchema.properties.buyer.$ref).toBe("Orders_Customer.json");
      expect(orderSchema.properties.agent.$ref).toBe("Tickets_Customer.json");
    });

    it("avro / java / protobuf: the colliding ones are qualified, the namespace / package is the full qualified path", async () => {
      expect((await emit(closure(), "avro")).files.map((f) => f.path)).toEqual([
        "com.superschema.sales.orders.customer.OrdersCustomer.avsc.json",
        "com.superschema.sales.orders.order.Order.avsc.json",
        "com.superschema.support.tickets.customer.TicketsCustomer.avsc.json",
      ]);
      expect((await emit(closure(), "java-pojo")).files.map((f) => f.path)).toEqual([
        "sales/orders/customer/OrdersCustomer.java",
        "sales/orders/order/Order.java",
        "support/tickets/customer/TicketsCustomer.java",
      ]);
      expect((await emit(closure(), "protobuf")).files.map((f) => f.path)).toEqual(["Sales/Orders/Customer.proto", "Sales/Orders/Order.proto", "Support/Tickets/Customer.proto"]);
    });
  });

  it.each(TARGETS)("%s: the same entity name in two domains with the same product name stays distinct (domain qualifies)", async (target) => {
    const closure = closureOf([
      member("o", "Sales", "Orders", "Order", [field("buyer", "reference", 1, toCustomer("c1", "Sales", "Orders")), field("agent", "reference", 2, toCustomer("c2", "Billing", "Orders"))]),
      customerIn("c1", "Sales", "Orders"),
      customerIn("c2", "Billing", "Orders"),
    ]);
    const { files } = await emit(closure, target);
    expect(files).toHaveLength(3);
    expect(new Set(files.map((f) => f.path)).size).toBe(3);
    if (target === "json-schema") expect(files.map((f) => f.path)).toEqual(["Billing_Orders_Customer.json", "Order.json", "Sales_Orders_Customer.json"]);
  });

  it.each(TARGETS)("%s: entity names that sanitize identically (`a-b` / `a_b`) stay distinct", async (target) => {
    const closure = closureOf([
      member("o", "D", "P", "Root", [
        field("x", "reference", 1, refTo({ entityId: "x", domain: "D", product: "P", entity: "a-b" })),
        field("y", "reference", 2, refTo({ entityId: "y", domain: "D", product: "P", entity: "a_b" })),
      ]),
      member("x", "D", "P", "a-b", [field("v", "string", 1)]),
      member("y", "D", "P", "a_b", [field("v", "string", 1)]),
    ]);
    const { files, warnings, entityFiles } = await emit(closure, target);
    expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
    // Their names stay distinct (hash last), but their NAMESPACE (domain.product.entity once sanitized) is one: OpenAPI and Protobuf
    // write one document / package for the pair, Avro and Java one file each in the same namespace. Every entity is still served.
    expect(files).toHaveLength(target === "openapi3" || target === "protobuf" ? 2 : 3);
    for (const id of ["o", "x", "y"]) expect(entityFiles[id].length).toBeGreaterThan(0);
    if (target === "json-schema") {
      expect(warnings).toEqual([]);
    } else {
      expect(warnings.some((w) => w.includes("a-b and a_b") && w.includes("share it"))).toBe(true);
    }
  });

  it.each(TARGETS)("%s: an entity named like the reserved closure root is emitted under a qualified name (the root must not be shadowed)", async (target) => {
    const closure = closureOf([
      member("o", "Billing", "Ledger", "SuperSchemaClosure", [field("c", "reference", 1, toCustomer("c1", "Billing", "Ledger"))]),
      customerIn("c1", "Billing", "Ledger"),
    ]);
    const { files } = await emit(closure, target);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.entityId).sort()).toEqual(["c1", "o"]);
    if (target === "json-schema") expect(files.map((f) => f.path)).toEqual(["Customer.json", "Ledger_SuperSchemaClosure.json"]);
  });
});

describe("a reference cycle and a self-reference", () => {
  const a = () => member("ea", "Sales", "Orders", "A", [field("peer", "reference", 1, refTo({ entityId: "eb", domain: "Sales", product: "Orders", entity: "B" }))]);
  const b = () => member("eb", "Sales", "Orders", "B", [field("peer", "reference", 1, refTo({ entityId: "ea", domain: "Sales", product: "Orders", entity: "A" }))]);
  const c = () => member("ec", "Sales", "Orders", "C", [field("a", "reference", 1, refTo({ entityId: "ea", domain: "Sales", product: "Orders", entity: "A" }))]);
  const cycle = () => closureOf([c(), a(), b()], [["Sales/Orders/A", "Sales/Orders/B"]]);

  it("protobuf: the members of a cycle share ONE package and file, with a warning; an outside entity imports it", async () => {
    const { files, warnings, entityFiles } = await emit(cycle(), "protobuf");
    expect(files.map((f) => f.path)).toEqual(["Sales/Orders/A.proto", "Sales/Orders/C.proto"]);
    const shared = byPath(files, "Sales/Orders/A.proto").content;
    expect(shared).toContain("package Sales.Orders.A;");
    expect(shared).toMatch(/message A \{[^}]*B peer = 2;/);
    expect(shared).toMatch(/message B \{[^}]*A peer = 2;/);
    expect(shared).not.toContain("import ");
    expect(byPath(files, "Sales/Orders/C.proto").content).toContain('import "Sales/Orders/A.proto";');
    expect(warnings.some((w) => w.includes("Sales/Orders/A") && w.includes("Sales/Orders/B") && /share/i.test(w))).toBe(true);
    // the shared file is tagged with the first member only: the second member is served through entityFiles
    expect(byPath(files, "Sales/Orders/A.proto").entityId).toBe("ea");
    expect(filesForEntity(files, "eb")).toEqual([]);
    expect(entityFiles).toEqual({ ea: ["Sales/Orders/A.proto"], eb: ["Sales/Orders/A.proto"], ec: ["Sales/Orders/C.proto"] });
  });

  it("json-schema: the files point at each other with a native $ref", async () => {
    const { files, warnings } = await emit(cycle(), "json-schema");
    expect(files.map((f) => f.path)).toEqual(["A.json", "B.json", "C.json"]);
    expect(JSON.parse(byPath(files, "A.json").content).properties.peer.$ref).toBe("B.json");
    expect(JSON.parse(byPath(files, "B.json").content).properties.peer.$ref).toBe("A.json");
    expect(JSON.parse(byPath(files, "C.json").content).properties.a.$ref).toBe("A.json");
    expect(warnings).toEqual([]);
  });

  it("openapi3: each service holds both members of the cycle, referring to each other natively", async () => {
    const { files, warnings } = await emit(cycle(), "openapi3");
    expect(files.map((f) => f.path)).toEqual(["openapi.Sales.Orders.A.yaml", "openapi.Sales.Orders.B.yaml", "openapi.Sales.Orders.C.yaml"]);
    for (const f of ["openapi.Sales.Orders.A.yaml", "openapi.Sales.Orders.B.yaml", "openapi.Sales.Orders.C.yaml"]) {
      const doc = parseYaml(byPath(files, f).content) as { components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> } };
      expect(Object.keys(doc.components.schemas).sort()).toEqual(f.includes(".C.") ? ["A", "B", "C"] : ["A", "B"]);
      expect(doc.components.schemas.A.properties?.peer.$ref).toBe("#/components/schemas/B");
      expect(doc.components.schemas.B.properties?.peer.$ref).toBe("#/components/schemas/A");
    }
    expect(warnings).toEqual([]);
  });

  it("avro: the first use of the other member is inline, the way back to the file's own record is by full name", async () => {
    const { files, warnings } = await emit(cycle(), "avro");
    expect(files.map((f) => f.path)).toEqual([
      "com.superschema.sales.orders.a.A.avsc.json",
      "com.superschema.sales.orders.b.B.avsc.json",
      "com.superschema.sales.orders.c.C.avsc.json",
    ]);
    const aSchema = JSON.parse(byPath(files, "A.avsc.json").content);
    expect(aSchema.namespace).toBe("com.superschema.sales.orders.a");
    const inlineB = aSchema.fields.find((f: { name: string }) => f.name === "peer").type;
    expect(inlineB).toMatchObject({ type: "record", name: "B", namespace: "com.superschema.sales.orders.b" });
    expect(inlineB.fields.find((f: { name: string }) => f.name === "peer").type).toBe("com.superschema.sales.orders.a.A");
    const bSchema = JSON.parse(byPath(files, "B.avsc.json").content);
    expect(bSchema.fields.find((f: { name: string }) => f.name === "peer").type).toMatchObject({ type: "record", name: "A" });
    expect(warnings).toEqual([]);
  });

  it("java: the cyclic set imports across packages and compiles with javac", async () => {
    const { files, warnings } = await emit(cycle(), "java-pojo");
    expect(files.map((f) => f.path)).toEqual(["sales/orders/a/A.java", "sales/orders/b/B.java", "sales/orders/c/C.java"]);
    expect(byPath(files, "A.java").content).toContain("import sales.orders.b.B;");
    expect(byPath(files, "B.java").content).toContain("import sales.orders.a.A;");
    expect(warnings).toEqual([]);
    if (!JAVAC_AVAILABLE) return;
    const compiled = compileJava(files);
    expect(compiled.status, compiled.stderr).toBe(0);
  });

  const selfRef = () => closureOf(
    [member("s", "Sales", "Orders", "Node", [field("parent", "reference", 1, refTo({ entityId: "s", domain: "Sales", product: "Orders", entity: "Node" }))])],
    [["Sales/Orders/Node"]]
  );

  it.each(TARGETS)("%s: a self-reference emits its own single file, with the stand-alone names", async (target) => {
    const { files, warnings, entityFiles } = await emit(selfRef(), target);
    expect(files).toHaveLength(1);
    expect(files[0].entityId).toBe("s");
    expect(entityFiles).toEqual({ s: [files[0].path] });
    expect(text(files)).not.toContain("SuperSchemaClosure");
    expect(warnings).toEqual([]);
  });

  it("the self-reference refers to its own file / record / class / schema, by the entity name", async () => {
    expect(JSON.parse((await emit(selfRef(), "json-schema")).files[0].content).properties.parent.$ref).toBe("Node.json");
    expect(JSON.parse((await emit(selfRef(), "avro")).files[0].content).fields[1].type).toBe("com.superschema.sales.orders.node.Node");
    const openapi = parseYaml((await emit(selfRef(), "openapi3")).files[0].content) as { components: { schemas: { Node: { properties: { parent: { $ref: string } } } } } };
    expect(openapi.components.schemas.Node.properties.parent.$ref).toBe("#/components/schemas/Node");
    expect((await emit(selfRef(), "protobuf")).files[0].content).toMatch(/message Node \{[^}]*Node parent = 2;/);
    const java = await emit(selfRef(), "java-pojo");
    expect(java.files[0].path).toBe("sales/orders/node/Node.java");
    expect(java.files[0].content).toContain("private Node parent;");
  });
});

describe("the reference pin never reaches a target", () => {
  it.each(TARGETS)("%s", async (target) => {
    const pinned = closureOf([
      member("o", "Sales", "Orders", "Order", [field("buyer", "reference", 1, refTo(CUSTOMER, { pinnedVersion: "1.0" }))]),
      customer(),
      address(),
    ]);
    const { files } = await emit(pinned, target);
    expect(files).toHaveLength(3);
    expect(text(files)).not.toContain("x-super-schema-pin");
  });
});

describe("a stand-alone entity (one entity, no references) keeps today's content", () => {
  const solo = () => {
    const m = member("e1", "Sales", "Orders", "Customer", [field("name", "string", 1)]);
    return closureOf([{ ...m, entity: { ...m.entity, domainId: "d1", domain: { id: "d1", name: "Sales", slug: "sales" } } }]);
  };

  it("json-schema: Customer.json, no bundle", async () => {
    const { files } = await emit(solo(), "json-schema");
    expect(files.map((f) => f.path)).toEqual(["Customer.json"]);
    expect(files[0].entityId).toBe("e1");
    expect(JSON.parse(files[0].content).properties.name.type).toBe("string");
  });

  it("protobuf keeps today's file, package (none: the stand-alone source has no @package name) and message name", async () => {
    const { files } = await emit(solo(), "protobuf");
    expect(files.map((f) => f.path)).toEqual(["main.proto"]);
    expect(files[0].entityId).toBe("e1");
    expect(files[0].content).not.toContain("package ");
    expect(files[0].content).toContain("message Customer {");
  });

  it("avro and java keep today's names and options (no closure namespace, no qualified file name)", async () => {
    expect((await emit(solo(), "avro")).files.map((f) => f.path)).toEqual(["Customer.avsc.json"]);
    expect((await emit(solo(), "java-pojo")).files.map((f) => f.path)).toEqual(["com/superschema/generated/Customer.java"]);
  });

  it("openapi3 keeps the entity name as the schema name", async () => {
    const { files } = await emit(solo(), "openapi3");
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("Customer:");
  });

  it.each(TARGETS)("%s: emitOfficialTypeSpecTargetFromData delegates and returns the same bundled output", async (target) => {
    const closure = solo();
    const direct = await emit(closure, target);
    const e = closure.entities[0];
    const viaFromData = await emitOfficialTypeSpecTargetFromData(e.entity, e.fields, target);
    expect(viaFromData.validationStatus).toBe("VALID");
    expect(viaFromData.output).toBe(bundleEmittedFiles(direct.files));
  });
});

describe("the catalog says which targets emit a closure", () => {
  it("flags exactly the five schema targets, not the DB targets or the multi-file code generators", () => {
    for (const key of TARGETS) expect(supportsClosureEmission(key)).toBe(true);
    for (const key of ["postgresql", "spanner", "bigquery", "http-client-js", "nope"]) expect(supportsClosureEmission(key)).toBe(false);
  });
});

describe("what emitClosure refuses, without throwing", () => {
  it("an unknown target and a DB target", async () => {
    const unknown = await emitClosure(threeEntities(), "nope");
    expect(unknown).toMatchObject({ success: false, error: { code: "UNSUPPORTED_TARGET" } });
    const db = await emitClosure(threeEntities(), "postgresql");
    expect(db).toMatchObject({ success: false, error: { code: "UNSUPPORTED_TARGET" } });
    expect(!db.success && db.error.message).toMatch(/closure/i);
  });

  it("a target the Schemas tab does not offer", async () => {
    expect(await emitClosure(threeEntities(), "http-client-js")).toMatchObject({ success: false, error: { code: "UNSUPPORTED_TARGET" } });
  });

  it("an empty closure", async () => {
    expect(await emitClosure({ entities: [], cycles: [] }, "json-schema")).toMatchObject({ success: false, error: { code: "EMPTY_CLOSURE" } });
  });

  it("a name that two fields turn into the same identifier names the entity that has it", async () => {
    const clash = member("x", "Sales", "Orders", "Clash", [field("a-b", "string", 1), field("a_b", "string", 2)]);
    const result = await emitClosure(closureOf([order(), customer(), address(), clash]), "avro");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("EMISSION_INVALID");
    expect(result.error.message).toContain("Clash");
    expect(result.error.message).toContain('"a-b"');
    expect(result.error.message).toContain('"a_b"');
  });

  it("an entity name longer than the emitters accept", async () => {
    const long = member("l", "Sales", "Orders", "L".repeat(200), [field("x", "string", 1)]);
    const result = await emitClosure(closureOf([order(), customer(), address(), long]), "json-schema");
    expect(result).toMatchObject({ success: false, error: { code: "EMISSION_INVALID" } });
  });

  it("a hostile entity name still compiles to a file (names are sanitized, nothing throws)", async () => {
    const hostile = member("h", "Sales", "Orders", 'Evil"; model Boom {} //', [field("x", "string", 1)]);
    const result = await emitClosure(closureOf([order(), customer(), address(), hostile]), "json-schema");
    expect(result.success).toBe(true);
  });
});

describe("interfaces with operations", () => {
  const withOperations = (returns: string) => ({
    custom: {
      interfaces: [
        {
          name: "AddressApi",
          operations: [
            { name: "getAddress", httpMethod: "GET", httpPath: "/addr/{id}", parameters: [{ name: "id", type: "string", location: "path", required: true }], responses: [{ statusCode: 200, type: returns }] },
          ],
        },
      ],
    },
  });

  it.each(TARGETS)("%s: refused in a multi-entity closure, naming the entity (a bare model name in an operation would bind to the namespace and emit `{}`)", async (target) => {
    const root = member("o", "Sales", "Orders", "Order", [field("ship", "reference", 1, refTo(ADDRESS))], withOperations("Order"));
    const result = await emitClosure(closureOf([root, address()]), target);
    expect(result).toMatchObject({ success: false, error: { code: "EMISSION_INVALID" } });
    expect(!result.success && result.error.message).toMatch(/Order: interface "AddressApi" has operations/);
  });

  it("a stand-alone entity keeps its operations on openapi3 (today's behaviour)", async () => {
    const solo = member("o", "Sales", "Orders", "Order", [field("x", "string", 1)], withOperations("Order"));
    const { files } = await emit(closureOf([solo]), "openapi3");
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("/addr/{id}:");
  });
});

describe("a reference whose target is not in the closure", () => {
  it.each(TARGETS)("%s: the field is emitted untyped and the user is told", async (target) => {
    const withGhost = member("o", "Sales", "Orders", "Order", [
      field("ship", "reference", 1, refTo(ADDRESS)),
      field("ghost", "reference", 2, refTo({ entityId: "gone", domain: "X", product: "Y", entity: "Ghost" })),
    ]);
    const { files, warnings } = await emit(closureOf([withGhost, address()]), target);
    expect(files).toHaveLength(2);
    expect(warnings.some((w) => w.includes("ghost") && w.includes("X/Y/Ghost"))).toBe(true);
  });
});
