/**
 * What the corpus's reference cases (tests/fixtures/corpus/reference-cases.ts) must produce, beyond "it validates": the closure the
 * app's resolver walks over the case's tenant, and the files the emitter writes for it. Generation here is the corpus's own
 * (`emitCaseClosure`: the REAL resolver over an in-memory tenant, then `emitClosure` with the real `tsp`), so this is the same chain
 * the full corpus run judges with the validators. Each case is generated on the targets the assertion is about, not on all five.
 */
import { describe, it, expect, vi } from "vitest";
import { CORPUS } from "../../fixtures/corpus/manifest";
import type { CorpusCase, ModelInput, TargetKey } from "../../fixtures/corpus/types";
import { buildCase, type BuiltCase } from "../../helpers/corpus/build-rows";
import { emitCaseClosure } from "../../helpers/corpus/run-case";
import { splitBundledFiles } from "../../helpers/corpus/validators";

vi.mock("server-only", () => ({}));
// the real emitters run (about a second each)
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function build(source: CorpusCase): Promise<BuiltCase> {
  const built = await buildCase(source);
  if (!built.ok) throw new Error(`case ${source.id} did not build: ${built.reason}`);
  return built.value;
}

const caseById = (id: string): CorpusCase => {
  const found = CORPUS.find((c) => c.id === id);
  if (!found) throw new Error(`no corpus case ${id}`);
  return found;
};

async function emit(id: string, target: TargetKey, from: CorpusCase = caseById(id)) {
  const built = await build(from);
  const result = await emitCaseClosure(built, built.fields, target);
  const files = new Map((result.closure?.files ?? []).map((f) => [f.path, f.content ?? ""]));
  return { result, files, entities: result.closure?.entities ?? [], pinned: result.closure?.pinned ?? [], cycles: result.closure?.cycles ?? [] };
}

const json = (files: Map<string, string>, path: string): Record<string, unknown> => JSON.parse(files.get(path) ?? "null") as Record<string, unknown>;
const props = (files: Map<string, string>, path: string): Record<string, Record<string, unknown>> => (json(files, path).properties ?? {}) as Record<string, Record<string, unknown>>;

describe("reference closure cases", () => {
  it("chain: the closure is the entity, what it references and what that references, root first; an entity nothing reaches is not in it", async () => {
    const { result, files, entities } = await emit("ref-chain", "json-schema");
    expect(result.validationStatus).toBe("VALID");
    expect(entities).toEqual(["Sales/Orders/PurchaseOrder", "Sales/Orders/Customer", "Sales/Orders/Address"]);
    expect([...files.keys()]).toEqual(["Address.json", "Customer.json", "PurchaseOrder.json"]);
    expect(props(files, "PurchaseOrder.json").buyer.$ref).toBe("Customer.json");
    expect(props(files, "Customer.json").home.$ref).toBe("Address.json");
    expect(Object.keys(props(files, "Address.json")).sort()).toEqual(["city", "id", "zip"]);
  });

  it("cycle: both members are in the closure, each file points at the other; Protobuf shares one package and file and says so", async () => {
    const js = await emit("ref-cycle-two", "json-schema");
    expect(js.cycles).toEqual([["Sales/Orders/Child", "Sales/Orders/Parent"]]);
    expect([...js.files.keys()]).toEqual(["Child.json", "Parent.json"]);
    expect(props(js.files, "Child.json").parent.$ref).toBe("Parent.json");
    expect(JSON.stringify(props(js.files, "Parent.json").children)).toContain("Child.json");
    const proto = await emit("ref-cycle-two", "protobuf");
    expect(proto.files.size).toBe(1);
    expect(proto.result.warnings.join("\n")).toMatch(/reference each other; Protobuf imports must be acyclic/);
    expect([...proto.files.values()][0]).toMatch(/message Parent[\s\S]*message Child|message Child[\s\S]*message Parent/);
  });

  it("self-reference: one file that points at itself, on JSON Schema and Avro", async () => {
    const js = await emit("ref-self-reference", "json-schema");
    expect([...js.files.keys()]).toEqual(["Category.json"]);
    expect(props(js.files, "Category.json").parent.$ref).toBe("Category.json");
    expect(js.cycles).toEqual([["Sales/Orders/Category"]]);
    const avro = await emit("ref-self-reference", "avro");
    expect(avro.files.size).toBe(1);
    expect([...avro.files.values()][0]).toContain('"Category"');
  });

  it("array and map of references: both reach the same file, which is written once", async () => {
    const { files, entities } = await emit("ref-array-and-map", "json-schema");
    expect(entities).toEqual(["Sales/Orders/Catalog", "Sales/Orders/Item"]);
    // the map is `Record<Item>`: the JSON Schema emitter writes it as a library model of its own, which the Catalog file points at and
    // which points at Item. It stays in the set (a file pointing at a file that is not there is no usable set).
    expect([...files.keys()]).toEqual(["Catalog.json", "Item.json", "RecordItem.json"]);
    const catalog = props(files, "Catalog.json");
    expect(catalog.featured.$ref).toBe("Item.json");
    expect((catalog.items.items as { $ref: string }).$ref).toBe("Item.json");
    expect(catalog.bySku.$ref).toBe("RecordItem.json");
    expect(JSON.stringify(json(files, "RecordItem.json"))).toContain("Item.json");
  });

  it("the same entity name in two products: only the two Customers are qualified (product first); the entity that names neither keeps its name", async () => {
    const { files, entities } = await emit("ref-same-name-two-products", "json-schema");
    expect(entities.sort()).toEqual(["Sales/Retail/Customer", "Sales/Wholesale/Customer", "Sales/Orders/PurchaseOrder"].sort());
    expect([...files.keys()]).toEqual(["PurchaseOrder.json", "Retail_Customer.json", "Wholesale_Customer.json"]);
    const order = props(files, "PurchaseOrder.json");
    expect(order.retailBuyer.$ref).toBe("Retail_Customer.json");
    expect(order.wholesaleBuyer.$ref).toBe("Wholesale_Customer.json");
    // each file is its own entity's: the loyalty card of Retail, the account manager of Wholesale
    expect(Object.keys(props(files, "Retail_Customer.json"))).toContain("loyaltyCard");
    expect(Object.keys(props(files, "Wholesale_Customer.json"))).toContain("accountManager");
    expect(Object.keys(props(files, "Retail_Customer.json"))).not.toContain("accountManager");
  });

  it("tenant-level entities (no product, no domain) are in the closure under the `_tenant` placeholder", async () => {
    const { result, files, entities } = await emit("ref-tenant-level", "json-schema");
    expect(result.validationStatus).toBe("VALID");
    expect(entities.sort()).toEqual(["Billing/_tenant/Account", "Sales/Orders/Ledger", "_tenant/_tenant/TaxCode"].sort());
    expect([...files.keys()]).toEqual(["Account.json", "Ledger.json", "TaxCode.json"]);
    expect(props(files, "Ledger.json").tax.$ref).toBe("TaxCode.json");
    expect(Object.keys(props(files, "TaxCode.json"))).toEqual(["code", "rate"]);
  });

  it("a pinned reference generates the PUBLISHED version it names, not the live entity; unpinned it generates the live one", async () => {
    const pinned = await emit("ref-pinned", "json-schema");
    expect(pinned.pinned).toEqual(["Sales/Orders/Address"]);
    expect(Object.keys(props(pinned.files, "Address.json")).sort()).toEqual(["city", "id", "street"]);

    // the same case without the pin: the live Address (draft mode) is what the closure reads
    const source = caseById("ref-pinned").source as ModelInput;
    const unpinned: CorpusCase = {
      ...caseById("ref-pinned"),
      source: { ...source, fields: source.fields.map((f) => (f.name === "home" ? { ...f, decorators: { ...(f.decorators as Record<string, unknown>), referencedEntityVersion: undefined } } : f)) },
    };
    const live = await emit("ref-pinned", "json-schema", unpinned);
    expect(live.pinned).toEqual([]);
    expect(Object.keys(props(live.files, "Address.json")).sort()).toEqual(["city", "geohash", "id", "street", "zip"]);
  });

  it("a pin to a version that does not exist is refused, naming the reference", async () => {
    const source = caseById("ref-pinned").source as ModelInput;
    const bad: CorpusCase = { ...caseById("ref-pinned"), source: { ...source, siblings: source.siblings?.map((s) => ({ ...s, published: [] })) } };
    const { result } = await emit("ref-pinned", "json-schema", bad);
    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors[0]).toMatchObject({ message: expect.stringMatching(/PIN_NOT_FOUND: field "home" pins Sales\/Orders\/Address v1\.0, which does not exist/) });
  });

  it("a reference to a deleted entity next to one that resolves: the closure is the one that resolves, the other field is untyped and the warning names it", async () => {
    const { result, files, entities } = await emit("ref-dangling-in-closure", "json-schema");
    expect(result.validationStatus).toBe("WARNING");
    expect(entities).toEqual(["Sales/Orders/Dispatch", "Sales/Orders/Warehouse"]);
    expect(props(files, "Dispatch.json").from.$ref).toBe("Warehouse.json");
    for (const field of ["carrier", "driver"]) {
      expect(JSON.stringify(props(files, "Dispatch.json")[field]), field).not.toContain("$ref");
      expect(result.warnings.join("\n"), field).toContain(`"${field}"`);
    }
  });

  it("an entity that is a closure of one and references a deleted entity is refused by the compiler (known issue reference-to-missing-entity)", async () => {
    const { result } = await emit("ref-dangling-qualified", "json-schema");
    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors[0]).toMatchObject({ message: expect.stringContaining("Unknown identifier Carrier") });
  });

  it("a bare name two entities answer to is refused with BOTH candidates, on every closure target, and nothing is picked", async () => {
    for (const target of ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"] as const) {
      const { result } = await emit("ref-ambiguous-bare-name", target);
      expect(result.validationStatus, target).toBe("INVALID");
      const message = (result.errors[0] as { message: string }).message;
      expect(message, target).toContain('field "customer" names "Customer", which matches Sales/Retail/Customer, Sales/Wholesale/Customer');
    }
  });

  it("every file of every closure target of the multi-entity cases parses (the full corpus run then validates them with the target's validator)", async () => {
    const built = await build(caseById("ref-chain"));
    for (const target of ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"] as const) {
      const result = await emitCaseClosure(built, built.fields, target);
      expect(result.validationStatus, target).toBe("VALID");
      // one file per entity of the closure
      expect(result.closure?.files.map((f) => f.entityId).sort(), target).toEqual(["addr", "cust", "e1"]);
      // and the bundled output splits back into exactly those files
      expect(splitBundledFiles(result.output).map((f) => f.name), target).toEqual(result.closure?.files.map((f) => f.path));
    }
  });
});
