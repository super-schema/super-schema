import "dotenv/config"; // first: @/lib/db (pulled in by the service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { BUNDLED_TRAITS, bundledMarker, propertySummary } from "@/lib/events/bundled-traits";
import type { JsonObject } from "@/lib/events/types";
import { ensureBundledTraits } from "@/services/events/bundled-traits.service";
import { createTrait, deleteTrait, getTrait, updateTrait } from "@/services/events/trait.service";
import type { Result } from "@/types/result";
import { connectTestDb, createProductScope, cleanupDomains, stamp, testContext, unwrap } from "./helpers";

/**
 * Built-in (bundled) traits are read-only, and inline message properties (`spec.headers`) are validated: both through the service,
 * the way a request that bypasses the UI reaches them. Every test works in a tenant of its own; deleting it cascades its traits.
 */
let prisma: PrismaClient;
let ctx: ServiceContext;
let tenantId: string;
let owner: { level: "TENANT"; tenantId: string };

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  const s = stamp();
  tenantId = (await prisma.tenant.create({ data: { name: `tsb-${s}`, slug: `tsb-${s}` } })).id;
  owner = { level: "TENANT", tenantId };
  unwrap(await ensureBundledTraits(prisma, tenantId));
}, 60_000);
afterAll(async () => {
  try {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  } finally {
    await prisma.$disconnect();
  }
});

const bundledRow = (name: string) => prisma.trait.findFirstOrThrow({ where: { tenantId, name } });
const traitCount = () => prisma.trait.count({ where: { tenantId } });
function failureOf(result: Result<unknown>) {
  if (result.success) throw new Error("expected a failure Result");
  return result.error;
}
const headers = (extra: JsonObject = {}): JsonObject => ({ type: "object", required: ["tenant"], properties: { tenant: { type: "string", description: "Owning tenant" } }, ...extra });

describe("built-in traits are read-only", () => {
  it("updateTrait refuses a built-in trait with a clear message and changes nothing", async () => {
    const row = await bundledRow("CloudEvents");
    const before = await prisma.trait.findUniqueOrThrow({ where: { id: row.id } });

    const error = failureOf(await updateTrait(row.id, { name: "CloudEvents", spec: structuredClone(row.spec as JsonObject) }, owner, ctx)); // even an identical save
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("CloudEvents is built in and can't be modified");
    expect(error.details).toEqual({ bundled: "cloudevents@1.0" });
    expect(error.suggestedFix).toMatch(/Apply it to a message/);

    expect(await prisma.trait.findUniqueOrThrow({ where: { id: row.id } })).toEqual(before);
  });

  it("refuses every kind of edit: rename, new spec, cleared spec, headers pin, and the other built-in too", async () => {
    for (const def of BUNDLED_TRAITS) {
      const row = await bundledRow(def.name);
      const attempts = [
        { name: "Renamed" },
        { name: def.name, spec: { summary: "hacked" } },
        { name: def.name },
        { name: def.name, spec: { ...structuredClone(def.spec), summary: "changed" } },
        { name: def.name, spec: {}, headers: null },
        { name: def.name, headers: { entityId: "some-entity" } },
      ];
      for (const attempt of attempts) {
        const error = failureOf(await updateTrait(row.id, attempt as never, owner, ctx));
        expect(error.code).toBe("FORBIDDEN");
        expect(error.message).toBe(`${def.name} is built in and can't be modified`);
      }
      const after = await prisma.trait.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.name).toBe(def.name);
      expect(after.spec).toEqual(def.spec);
    }
  });

  it("deleteTrait refuses a built-in trait: it stays, and so does its definition", async () => {
    for (const def of BUNDLED_TRAITS) {
      const row = await bundledRow(def.name);
      const error = failureOf(await deleteTrait(row.id, owner, ctx));
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe(`${def.name} is built in and can't be deleted`);
      expect(error.details).toEqual({ bundled: def.id });
      expect(await prisma.trait.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ name: def.name, spec: def.spec });
    }
  });

  it("is refused for another level's owner as well (the ownership error comes first, the trait is never touched)", async () => {
    const row = await bundledRow("CloudEvents");
    const sc = await createProductScope(prisma, ctx);
    try {
      const wrongOwner = { level: "DOMAIN" as const, domainId: sc.domain.id };
      expect(failureOf(await deleteTrait(row.id, wrongOwner, ctx)).code).toBe("FORBIDDEN");
      expect(failureOf(await updateTrait(row.id, { name: "CloudEvents" }, wrongOwner, ctx)).code).toBe("FORBIDDEN");
      expect(await prisma.trait.count({ where: { id: row.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [sc.domain.id]);
    }
  });

  it("getTrait returns the built-in with its marker and its properties (the UI shows them locked)", async () => {
    const row = await bundledRow("CloudEvents");
    const trait = unwrap(await getTrait(row.id, ctx));
    expect(bundledMarker(trait.spec)).toBe("cloudevents@1.0");
    expect(propertySummary(trait.spec).filter((p) => p.required).map((p) => p.name)).toEqual(["specversion", "id", "source", "type"]);
    expect(trait.headers).toBeNull();
  });

  it("createTrait refuses a spec that claims to be built in, whatever the value, and creates nothing", async () => {
    const before = await traitCount();
    for (const marker of ["cloudevents@1.0", "my-own@1", "", false, null, 1, { id: "x" }]) {
      const error = failureOf(await createTrait(owner, { name: `Forged-${stamp()}`, kind: "MESSAGE", spec: { summary: "forged", "x-bundled": marker } as JsonObject }, ctx));
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toMatch(/"x-bundled" key is reserved for built-in message properties/);
    }
    const operation = failureOf(await createTrait(owner, { name: `Forged-${stamp()}`, kind: "OPERATION", spec: { "x-bundled": "cloudevents@1.0" } }, ctx));
    expect(operation.code).toBe("VALIDATION_ERROR");
    expect(await traitCount()).toBe(before);
  });

  it("updateTrait refuses to turn a custom trait into a built-in, and the custom trait is unchanged", async () => {
    const custom = unwrap(await createTrait(owner, { name: `Custom-${stamp()}`, kind: "MESSAGE", spec: { summary: "mine" } }, ctx));
    const error = failureOf(await updateTrait(custom.id, { name: custom.name, spec: { summary: "mine", "x-bundled": "cloudevents@1.0" } }, owner, ctx));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(unwrap(await getTrait(custom.id, ctx))).toMatchObject({ name: custom.name, spec: { summary: "mine" } });
    // a custom trait stays fully editable and deletable
    expect(unwrap(await updateTrait(custom.id, { name: custom.name, spec: { summary: "edited" } }, owner, ctx)).spec).toEqual({ summary: "edited" });
    expect(unwrap(await deleteTrait(custom.id, owner, ctx))).toEqual({ id: custom.id });
  });

  it("a custom trait that merely looks like a built-in is an ordinary trait", async () => {
    const lookalike = unwrap(await createTrait(owner, { name: `Lookalike-${stamp()}`, kind: "MESSAGE", spec: { summary: "CloudEvents 1.0 context attributes", bundled: true, "x-bundle": "cloudevents@1.0" } }, ctx));
    expect(unwrap(await updateTrait(lookalike.id, { name: lookalike.name, spec: { summary: "renamed" } }, owner, ctx)).spec).toEqual({ summary: "renamed" });
    expect(unwrap(await deleteTrait(lookalike.id, owner, ctx))).toEqual({ id: lookalike.id });
  });
});

describe("inline message properties (spec.headers)", () => {
  it("a MESSAGE library trait can carry an inline headers schema, stored and returned as given", async () => {
    const trait = unwrap(await createTrait(owner, { name: `Inline-${stamp()}`, kind: "MESSAGE", spec: { summary: "tenant header", headers: headers() } }, ctx));
    expect(trait.headers).toBeNull(); // no entity pin: the properties are the inline schema
    expect(trait.spec).toEqual({ summary: "tenant header", headers: headers() });
    expect(propertySummary(trait.spec)).toEqual([{ name: "tenant", type: "string", required: true, description: "Owning tenant" }]);
    expect(await prisma.schemaReference.count({ where: { fromKind: "TRAIT", fromId: trait.id } })).toBe(0);

    const changed = unwrap(await updateTrait(trait.id, { name: trait.name, spec: { headers: headers({ properties: { tenant: { type: "string" }, region: { type: "string" } } }) } }, owner, ctx));
    expect(propertySummary(changed.spec).map((p) => p.name)).toEqual(["tenant", "region"]);
  });

  it("rejects a headers schema that is not an object schema, with the problem named", async () => {
    const before = await traitCount();
    const cases: Array<[string, unknown, RegExp]> = [
      ["not an object", "type: object", /Headers must be a JSON Schema object/],
      ["an array", [], /Headers must be a JSON Schema object/],
      ["no type", { properties: { a: { type: "string" } } }, /"type": "object"/],
      ["wrong type", { type: "array" }, /"type": "object"/],
      ["properties not an object", { type: "object", properties: ["a"] }, /"properties" must be an object of schemas/],
      ["a property that is not a schema", { type: "object", properties: { a: "string" } }, /property "a" must be a schema/],
      ["required not a list", { type: "object", properties: { a: {} }, required: "a" }, /"required" must be a list of property names/],
      ["required with a non-string", { type: "object", properties: { a: {} }, required: [1] }, /"required" must be a list of property names/],
      ["required not in properties", { type: "object", properties: { a: {} }, required: ["a", "b"] }, /lists "b", which is not one of the headers properties/],
      ["required but no properties", { type: "object", required: ["a"] }, /lists "a"/],
    ];
    for (const [label, value, message] of cases) {
      const error = failureOf(await createTrait(owner, { name: `Bad-${stamp()}`, kind: "MESSAGE", spec: { headers: value } as JsonObject }, ctx));
      expect(error.code, label).toBe("VALIDATION_ERROR");
      expect(error.message, label).toMatch(message);
      expect(error.suggestedFix, label).toMatch(/object schema/);
    }
    expect(await traitCount()).toBe(before);
  });

  it("applies the same checks on update and leaves the stored trait unchanged when they fail", async () => {
    const trait = unwrap(await createTrait(owner, { name: `Inline-${stamp()}`, kind: "MESSAGE", spec: { headers: headers() } }, ctx));
    const error = failureOf(await updateTrait(trait.id, { name: trait.name, spec: { headers: headers({ required: ["tenant", "ghost"] }) } }, owner, ctx));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toMatch(/lists "ghost"/);
    expect(unwrap(await getTrait(trait.id, ctx)).spec).toEqual({ headers: headers() });
  });

  it("an OPERATION trait cannot carry headers (they would silently disappear from the emitted document)", async () => {
    const error = failureOf(await createTrait(owner, { name: `OpHeaders-${stamp()}`, kind: "OPERATION", spec: { headers: headers() } }, ctx));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("Only MESSAGE traits can carry headers");
  });

  it("a trait with a headers entity pin keeps working exactly as before (pinned headers, edge, update, delete)", async () => {
    const sc = await createProductScope(prisma, ctx);
    const created: string[] = [];
    try {
      const entity = await sc.publishedEntity(`CloudEventsHeaders${sc.s}`);
      const pinned = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Pinned-${sc.s}`, kind: "MESSAGE", spec: { summary: "pin" }, headers: { entityId: entity.entity.id } }, ctx));
      created.push(pinned.id);
      expect(pinned.headers).toEqual({ entityId: entity.entity.id, entityVersionId: entity.version.id });
      const edges = await prisma.schemaReference.findMany({ where: { fromKind: "TRAIT", fromId: pinned.id } });
      expect(edges.map((e) => [e.role, e.toKind, e.toId])).toEqual([["HEADERS", "ENTITY_VERSION", entity.version.id]]);

      // a pin together with an inline schema is allowed (the pin wins when emitted); both survive an update
      const both = unwrap(await updateTrait(pinned.id, { name: pinned.name, spec: { headers: headers() }, headers: { entityId: entity.entity.id } }, { level: "DOMAIN", domainId: sc.domain.id }, ctx));
      expect(both.headers).toEqual({ entityId: entity.entity.id, entityVersionId: entity.version.id });
      expect(both.spec).toEqual({ headers: headers() });
      expect(unwrap(await deleteTrait(pinned.id, { level: "DOMAIN", domainId: sc.domain.id }, ctx))).toEqual({ id: pinned.id });
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "TRAIT", fromId: { in: created } } });
      await cleanupDomains(prisma, [sc.domain.id]);
    }
  });
});
