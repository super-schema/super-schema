import { describe, expect, it, vi } from "vitest";
import { ok, type Result } from "@/types/result";
import type { ParsedField } from "@/lib/importers/types";
import type { ExtractedPayload } from "@/lib/events/import";
import { createNameAllocator, planPayloadEntities, resolveEntityNames, type NameAllocator, type PlannedPayload } from "@/services/events/import-payload-entities";
import { emptyRegistryDelegates } from "../../../helpers/registry-mocks";

// The module's service imports reach `@/lib/db`; nothing here touches a database.
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));

// Field names whose URL slugs collide (the unique (entity, slug) index would turn them into an opaque failure after a clean preview).
// `resolveEntityNames` is pure apart from the allocator, which is a stand-in here (it keeps every name).

const keep: NameAllocator = { allocate: async (requested): Promise<Result<string>> => ok(requested) };
const field = (name: string): ParsedField => ({ name, type: "string", nullable: false, confidence: "high", originalType: "string" });
const plan = (...names: string[]): PlannedPayload => ({
  pinKey: "m:payload", sourcePointer: "/components/messages/m/payload", format: "json-schema",
  entities: [{ requestedName: "Order", sourceName: "Order", description: "", fields: names.map(field) }],
});
const namesOf = async (...fields: string[]) => {
  const resolved = await resolveEntityNames([plan(...fields)], keep);
  if (!resolved.success) throw new Error(resolved.error.message);
  return { names: resolved.data.payloads[0].entities[0].input.fields.map((f) => f.name), warnings: resolved.data.warnings };
};

describe("resolveEntityNames: field slug collisions", () => {
  it("leaves fields whose slugs differ alone, with no warning", async () => {
    const { names, warnings } = await namesOf("id", "Order Id", "order_total", "total");
    expect(names).toEqual(["id", "Order Id", "order_total", "total"]);
    expect(warnings).toEqual([]);
  });

  it("numbers the later of two fields with the same slug (a b / a-b / a_b are all a-b) and names entity and field in a SANITIZED_VALUE warning", async () => {
    const { names, warnings } = await namesOf("a b", "a-b", "a_b");
    expect(names).toEqual(["a b", "a-b2", "a_b3"]);
    expect(warnings.map((w) => [w.code, w.pointer, w.message])).toEqual([
      ["SANITIZED_VALUE", "/components/messages/m/payload", 'Entity "Order": the field "a-b" has the same URL slug as an earlier field, so it is named "a-b2".'],
      ["SANITIZED_VALUE", "/components/messages/m/payload", 'Entity "Order": the field "a_b" has the same URL slug as an earlier field, so it is named "a_b3".'],
    ]);
  });

  it("names with no Latin letter slug to empty: the first keeps its name, the others are numbered (and the numbers are free)", async () => {
    const jp = "日本語";
    const cn = "中文";
    const kr = "한국어";
    const { names } = await namesOf(jp, cn, kr, "2", "3");
    // `cn` -> "<cn>2" (slug "2"), `kr` -> "<kr>3" (slug "3"); the fields named "2" and "3" then collide and are numbered too
    expect(names.slice(0, 3)).toEqual([jp, `${cn}2`, `${kr}3`]);
    expect(new Set(names)).toHaveProperty("size", 5);
    expect(names[3]).not.toBe("2");
    expect(names[4]).not.toBe("3");
  });

  it("a number that is itself taken is skipped (a-b2 exists as a field already)", async () => {
    const { names } = await namesOf("a-b2", "a b", "a-b");
    expect(names).toEqual(["a-b2", "a b", "a-b3"]);
  });

  it("a single leftover collision is reported in the singular", async () => {
    const fields = Array.from({ length: 52 }, (_, i) => String.fromCodePoint(0x4e00 + i)); // 51 renames: 50 listed, 1 left over
    const { warnings } = await namesOf(...fields);
    expect(warnings).toHaveLength(51);
    expect(warnings.at(-1)).toEqual({ pointer: "", code: "SANITIZED_VALUE", message: "1 more field was renamed because its URL slug collided; it is not listed." });
  });

  it("2,000 fields of empty slug stay fast (linear, not quadratic) and unique, and only 50 are reported plus one summary", async () => {
    const fields = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + i)); // 2,000 different CJK characters, all slug ""
    const started = performance.now();
    const { names, warnings } = await namesOf(...fields);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Set(names).size).toBe(2000);
    expect(names[0]).toBe(fields[0]);
    expect(warnings.filter((w) => w.message.startsWith('Entity "Order"'))).toHaveLength(50);
    expect(warnings.at(-1)).toEqual({ pointer: "", code: "SANITIZED_VALUE", message: "1949 more fields were renamed because their URL slugs collided; they are not listed." });
    expect(warnings).toHaveLength(51);
  });
});

// ── one Avro schema used by two messages (the importer runs once; each plan is renamed on its own) ──

/** Hands out `name`, `name2`, `name3`, ... and never the same name twice, like the real allocator over an empty product. */
function distinctAllocator(): NameAllocator {
  const taken = new Set<string>();
  return {
    allocate: async (requested): Promise<Result<string>> => {
      for (let n = 1; ; n += 1) {
        const candidate = n === 1 ? requested : `${requested}${n}`;
        if (!taken.has(candidate.toLowerCase())) {
          taken.add(candidate.toLowerCase());
          return ok(candidate);
        }
      }
    },
  };
}

describe("one Avro schema reused by two messages", () => {
  const avro = {
    type: "record", name: "Order", fields: [
      { name: "to", type: { type: "record", name: "Address", fields: [{ name: "street", type: "string" }] } },
      { name: "next", type: ["null", "Order"] },
    ],
  };
  const message = (messageKey: string): ExtractedPayload => ({ messageKey, role: "payload", sourcePointer: `/components/messages/${messageKey}/payload`, format: "avro", raw: avro, suggestedName: "X" });
  const referenceOf = (entity: { input: { fields: Array<{ name: string; decorators?: Record<string, unknown> }> } }, field: string) =>
    (entity.input.fields.find((f) => f.name === field)?.decorators as { referencedEntityName?: string } | undefined)?.referencedEntityName;

  it("renames the second message's entities (Order2, Address2) and rewrites ITS references, leaving the first message's and the shared parse untouched", async () => {
    const { plans } = planPayloadEntities([message("first"), message("second")]);
    expect(plans.map((p) => p.entities.map((e) => e.requestedName))).toEqual([["Order", "Address"], ["Order", "Address"]]);
    expect(plans[0].entities[1].fields).toBe(plans[1].entities[1].fields); // the importer ran once: both plans hold the very same field list
    const before = JSON.stringify(plans);

    const resolved = await resolveEntityNames(plans, distinctAllocator());

    if (!resolved.success) throw new Error(resolved.error.message);
    const [first, second] = resolved.data.payloads;
    expect(first.entities.map((e) => [e.name, e.renamed])).toEqual([["Order", false], ["Address", false]]);
    expect(second.entities.map((e) => [e.name, e.renamed])).toEqual([["Order2", true], ["Address2", true]]);
    expect([referenceOf(first.entities[0], "to"), referenceOf(first.entities[0], "next")]).toEqual(["Address", "Order"]);
    expect([referenceOf(second.entities[0], "to"), referenceOf(second.entities[0], "next")]).toEqual(["Address2", "Order2"]);
    expect(JSON.stringify(plans)).toBe(before); // nothing the plans share was written to
    expect(resolved.data.warnings.filter((w) => w.code === "ENTITY_RENAMED")).toHaveLength(2);
  });
});

// ── a field named like a key the AsyncAPI parser cannot read (PARSER_UNSAFE_KEYS): an Avro / Protobuf field name is a VALUE in the
// document, so it passes the importer's source check and would become an entity field (and a payload property that crashes the parser) ──

describe("resolveEntityNames: reserved field names", () => {
  it("renames hasOwnProperty to hasOwnProperty_1 and warns, naming the field, its new name and the entity", async () => {
    const { names, warnings } = await namesOf("id", "hasOwnProperty", "total");
    expect(names).toEqual(["id", "hasOwnProperty_1", "total"]);
    expect(warnings).toEqual([
      {
        pointer: "/components/messages/m/payload", code: "SANITIZED_VALUE",
        message: 'The field "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved. It belongs to the entity "Order".',
      },
    ]);
  });

  it("goes on to _2 when _1 is taken, trims a padded name, and leaves the look-alikes alone", async () => {
    expect((await namesOf("hasOwnProperty_1", "hasOwnProperty")).names).toEqual(["hasOwnProperty_1", "hasOwnProperty_2"]);
    expect((await namesOf(" hasOwnProperty ")).names).toEqual(["hasOwnProperty_1"]);
    const alike = await namesOf("hasownproperty", "HasOwnProperty3", "hasOwnProperty2");
    expect(alike.names).toEqual(["hasownproperty", "HasOwnProperty3", "hasOwnProperty2"]);
    expect(alike.warnings).toEqual([]);
  });

  it("reports at most 50 such renames and one summary, and every field is renamed", async () => {
    const entityFields = Array.from({ length: 1 }, () => "hasOwnProperty");
    const plans: PlannedPayload[] = Array.from({ length: 53 }, (_, i) => ({
      pinKey: `m${i}:payload`, sourcePointer: `/components/messages/m${i}/payload`, format: "json-schema",
      entities: [{ requestedName: `Order${i}`, sourceName: `Order${i}`, description: "", fields: entityFields.map(field) }],
    }));
    const resolved = await resolveEntityNames(plans, keep);
    if (!resolved.success) throw new Error(resolved.error.message);
    expect(resolved.data.payloads.every((p) => p.entities[0].input.fields[0].name === "hasOwnProperty_1")).toBe(true);
    expect(resolved.data.warnings).toHaveLength(51);
    expect(resolved.data.warnings.at(-1)).toEqual({ pointer: "", code: "SANITIZED_VALUE", message: "3 more fields were renamed because their names are reserved; they are not listed." });
  });
});

// ── an entity (or event) NAME that is a parser-unsafe key: the name allocator never hands it out ──

describe("createNameAllocator: reserved names", () => {
  const db = () => emptyRegistryDelegates() as never;
  const scope = { tenantId: "t", domainId: "d", productId: "p" };

  it("skips a requested name that is reserved, like a name that is taken: hasOwnProperty2 stands in for hasOwnProperty, for entities and for events", async () => {
    for (const kind of ["entity", "event"] as const) {
      const fresh = await createNameAllocator(db(), scope);
      if (!fresh.success) throw new Error(fresh.error.message);
      expect(await fresh.data.allocate("hasOwnProperty", kind), kind).toEqual({ success: true, data: "hasOwnProperty2" });
    }
    const allocator = await createNameAllocator(db(), scope);
    if (!allocator.success) throw new Error(allocator.error.message);
    expect(await allocator.data.allocate("hasownproperty", "entity")).toEqual({ success: true, data: "hasownproperty" });
  });

  it("resolveEntityNames reports the rename (ENTITY_RENAMED says the name is used or reserved) and the entity gets the allocated name", async () => {
    const allocator = await createNameAllocator(db(), scope);
    if (!allocator.success) throw new Error(allocator.error.message);
    const reserved: PlannedPayload = {
      pinKey: "m:payload", sourcePointer: "/components/messages/m/payload", format: "avro",
      entities: [{ requestedName: "hasOwnProperty", sourceName: "hasOwnProperty", description: "", fields: [field("id")] }],
    };
    const resolved = await resolveEntityNames([reserved], allocator.data);
    if (!resolved.success) throw new Error(resolved.error.message);
    expect(resolved.data.payloads[0].entities[0]).toMatchObject({ requestedName: "hasOwnProperty", name: "hasOwnProperty2", renamed: true });
    expect(resolved.data.warnings.map((w) => [w.code, w.message])).toEqual([
      ["ENTITY_RENAMED", 'The name "hasOwnProperty" is already used in this product (or is reserved), so the entity is named "hasOwnProperty2".'],
    ]);
  });
});
