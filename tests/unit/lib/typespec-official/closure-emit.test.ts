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
import { bundleEmittedFiles, emitClosure, filesForEntity, type EmittedFile } from "@/lib/typespec-official/closure-emit";
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

async function emit(closure: ReferenceClosure, target: string): Promise<{ files: EmittedFile[]; warnings: string[] }> {
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
  const out = {} as Record<(typeof TARGETS)[number], { files: EmittedFile[]; warnings: string[] }>;
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
    expect(files.map((f) => f.path)).toEqual(["Sales_Orders_Address.json", "Sales_Orders_Customer.json", "Sales_Orders_Order.json"]);
    const orderFile = JSON.parse(byPath(files, "Sales_Orders_Order.json").content);
    expect(orderFile.properties.ship.$ref).toBe("Sales_Orders_Address.json");
    expect(orderFile.properties.buyer.$ref).toBe("Sales_Orders_Customer.json");
    expect(byPath(files, "Sales_Orders_Order.json").content).toContain('"$ref": "Sales_Orders_Address.json"');
    expect(text(files)).not.toContain("$defs");
  });

  it("openapi3: each entity gets its own @service file, referenced entities are inlined in components.schemas, no external ref", () => {
    const { files } = out.openapi3;
    expect(files.map((f) => f.path)).toEqual(["openapi.Sales.Orders.Address.yaml", "openapi.Sales.Orders.Customer.yaml", "openapi.Sales.Orders.Order.yaml"]);
    const doc = parseYaml(byPath(files, "openapi.Sales.Orders.Order.yaml").content) as { info: { title: string }; components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> } };
    expect(doc.info.title).toBe("Order");
    expect(Object.keys(doc.components.schemas).sort()).toEqual(["Sales_Orders_Address", "Sales_Orders_Customer", "Sales_Orders_Order"]);
    expect(doc.components.schemas.Sales_Orders_Order.properties?.ship.$ref).toBe("#/components/schemas/Sales_Orders_Address");
    for (const f of files) {
      const refs = [...f.content.matchAll(/\$ref:\s*'?([^'\n]+)'?/g)].map((m) => m[1]);
      for (const ref of refs) expect(ref.startsWith("#/")).toBe(true);
    }
    // the Address file is its own service and carries only Address
    const addressDoc = parseYaml(byPath(files, "openapi.Sales.Orders.Address.yaml").content) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(addressDoc.components.schemas)).toEqual(["Sales_Orders_Address"]);
  });

  it("protobuf: one package per entity from its qualified path, imports between the files", () => {
    const { files } = out.protobuf;
    expect(files.map((f) => f.path)).toEqual(["Sales/Orders/Address.proto", "Sales/Orders/Customer.proto", "Sales/Orders/Order.proto"]);
    const orderProto = byPath(files, "Sales/Orders/Order.proto").content;
    expect(orderProto).toContain("package Sales.Orders.Order;");
    expect(orderProto).toContain('import "Sales/Orders/Address.proto";');
    expect(orderProto).toContain('import "Sales/Orders/Customer.proto";');
    expect(orderProto).toContain("message Sales_Orders_Order");
    expect(byPath(files, "Sales/Orders/Address.proto").content).not.toContain("import ");
  });

  it("avro: Order's file holds Address inline once, then refers to it by full name, in the entity's own namespace", () => {
    const { files } = out.avro;
    expect(files.map((f) => f.path)).toEqual([
      "com.superschema.sales.orders.address.SalesOrdersAddress.avsc.json",
      "com.superschema.sales.orders.customer.SalesOrdersCustomer.avsc.json",
      "com.superschema.sales.orders.order.SalesOrdersOrder.avsc.json",
    ]);
    const orderSchema = JSON.parse(byPath(files, "SalesOrdersOrder.avsc.json").content);
    expect(orderSchema.namespace).toBe("com.superschema.sales.orders.order");
    const definitions: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "record" && record.name === "SalesOrdersAddress") definitions.push(record);
      Object.values(record).forEach(walk);
    };
    walk(orderSchema);
    expect(definitions).toHaveLength(1);
    const ship = orderSchema.fields.find((f: { name: string }) => f.name === "ship");
    expect(ship.type).toBe("com.superschema.sales.orders.address.SalesOrdersAddress");
  });

  it("java: the classes import each other across packages and live under their package directories", () => {
    const { files } = out["java-pojo"];
    expect(files.map((f) => f.path)).toEqual([
      "sales/orders/address/SalesOrdersAddress.java",
      "sales/orders/customer/SalesOrdersCustomer.java",
      "sales/orders/order/SalesOrdersOrder.java",
    ]);
    const orderJava = byPath(files, "SalesOrdersOrder.java").content;
    expect(orderJava).toContain("package sales.orders.order;");
    expect(orderJava).toContain("import sales.orders.address.SalesOrdersAddress;");
    expect(orderJava).toContain("import sales.orders.customer.SalesOrdersCustomer;");
  });

  const javacAvailable = spawnSync("javac", ["-version"]).status === 0;
  it.skipIf(!javacAvailable)("java: the set compiles with javac", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "closure-javac-"));
    try {
      const sources: string[] = [];
      for (const f of out["java-pojo"].files) {
        const full = path.join(dir, "src", f.path);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, f.content);
        sources.push(full);
      }
      const compiled = spawnSync("javac", ["-d", path.join(dir, "out"), ...sources], { encoding: "utf8" });
      expect(compiled.stderr).toBe("");
      expect(compiled.status).toBe(0);
      expect(readdirSync(path.join(dir, "out"))).toContain("sales");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
      expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(["Sales_Orders_Address.json", "Sales_Orders_Address_kind.json", "Sales_Orders_Address_Status.json"]));
      for (const f of files) expect(f.entityId).toBeDefined();
      expect(filesForEntity(files, "a").length).toBeGreaterThanOrEqual(3);
    } else if (target === "java-pojo") {
      // a class per model plus a class per enum, in the entity's package directory
      expect(files).toHaveLength(5);
      for (const f of files) expect(f.entityId).toBeDefined();
      expect(filesForEntity(files, "a").map((f) => f.path)).toEqual([
        "sales/orders/address/SalesOrdersAddress.java",
        "sales/orders/address/SalesOrdersAddressKind.java",
        "sales/orders/address/SalesOrdersAddressStatus.java",
      ]);
    } else {
      expect(files).toHaveLength(3);
      expect(files.map((f) => f.entityId).sort()).toEqual(["a", "c", "o"]);
    }
    if (target === "avro") expect(warnings.some((w) => w.includes("in-progress") && w.includes("in_progress"))).toBe(true);
  });
});

describe("same-named entities in two products", () => {
  const closure = () => {
    const customerA = member("c1", "Sales", "Orders", "Customer", [field("name", "string", 1)]);
    const customerB = member("c2", "Support", "Tickets", "Customer", [field("name", "string", 1)]);
    const root = member("o", "Sales", "Orders", "Order", [
      field("buyer", "reference", 1, refTo({ entityId: "c1", domain: "Sales", product: "Orders", entity: "Customer" })),
      field("agent", "reference", 2, refTo({ entityId: "c2", domain: "Support", product: "Tickets", entity: "Customer" })),
    ]);
    return closureOf([root, customerA, customerB]);
  };

  it.each(TARGETS)("%s: three distinct files, one per entity", async (target) => {
    const { files } = await emit(closure(), target);
    expect(files).toHaveLength(3);
    expect(new Set(files.map((f) => f.path)).size).toBe(3);
    expect(files.map((f) => f.entityId).sort()).toEqual(["c1", "c2", "o"]);
  });
});

describe("a reference cycle and a self-reference", () => {
  const a = () => member("ea", "Sales", "Orders", "A", [field("peer", "reference", 1, refTo({ entityId: "eb", domain: "Sales", product: "Orders", entity: "B" }))]);
  const b = () => member("eb", "Sales", "Orders", "B", [field("peer", "reference", 1, refTo({ entityId: "ea", domain: "Sales", product: "Orders", entity: "A" }))]);
  const c = () => member("ec", "Sales", "Orders", "C", [field("a", "reference", 1, refTo({ entityId: "ea", domain: "Sales", product: "Orders", entity: "A" }))]);
  const cycle = () => closureOf([c(), a(), b()], [["Sales/Orders/A", "Sales/Orders/B"]]);

  it("protobuf: the members of a cycle share ONE package and file, with a warning; an outside entity imports it", async () => {
    const { files, warnings } = await emit(cycle(), "protobuf");
    expect(files.map((f) => f.path)).toEqual(["Sales/Orders/A.proto", "Sales/Orders/C.proto"]);
    const shared = byPath(files, "Sales/Orders/A.proto").content;
    expect(shared).toContain("package Sales.Orders.A;");
    expect(shared).toContain("message Sales_Orders_A");
    expect(shared).toContain("message Sales_Orders_B");
    expect(shared).not.toContain("import ");
    expect(byPath(files, "Sales/Orders/C.proto").content).toContain('import "Sales/Orders/A.proto";');
    expect(warnings.some((w) => w.includes("Sales/Orders/A") && w.includes("Sales/Orders/B") && /share/i.test(w))).toBe(true);
    expect(byPath(files, "Sales/Orders/A.proto").entityId).toBe("ea");
  });

  it.each(["json-schema", "openapi3", "avro", "java-pojo"])("%s: a cycle emits one file per entity, no warning", async (target) => {
    const { files, warnings } = await emit(cycle(), target);
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.entityId).sort()).toEqual(["ea", "eb", "ec"]);
    expect(warnings).toEqual([]);
  });

  const selfRef = () => closureOf(
    [member("s", "Sales", "Orders", "Node", [field("parent", "reference", 1, refTo({ entityId: "s", domain: "Sales", product: "Orders", entity: "Node" }))])],
    [["Sales/Orders/Node"]]
  );

  it.each(TARGETS)("%s: a self-reference emits its own single file", async (target) => {
    const { files, warnings } = await emit(selfRef(), target);
    expect(files).toHaveLength(1);
    expect(files[0].entityId).toBe("s");
    expect(text(files)).not.toContain("SuperSchemaClosure");
    expect(warnings).toEqual([]);
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
