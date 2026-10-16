import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";
import { ensureBundledTraits } from "@/services/events/bundled-traits.service";
import { loadTraitOptions } from "@/features/events/load-options";
import { connectTestDb, stamp, unwrap } from "./helpers";

/**
 * `loadTraitOptions` hands the builder each trait's stored definition (`spec`), whether it is built in, and its property rows.
 * Every row lives in a tenant of its own, deleted afterwards.
 */
let prisma: PrismaClient;
let tenantId: string;
let scope: { tenantId: string; domainId: null; productId: null };

beforeAll(async () => {
  prisma = connectTestDb();
  const s = stamp();
  tenantId = (await prisma.tenant.create({ data: { name: `lop-${s}`, slug: `lop-${s}` } })).id;
  scope = { tenantId, domainId: null, productId: null };
  unwrap(await ensureBundledTraits(prisma, tenantId));
}, 60_000);
afterAll(async () => {
  try {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  } finally {
    await prisma.$disconnect();
  }
});

const def = (name: string) => BUNDLED_TRAITS.find((t) => t.name === name)!;

describe("loadTraitOptions: the stored definition travels with the option", () => {
  it("returns the built-in traits flagged as built in, with their exact spec and property rows in the definition's order", async () => {
    const options = await loadTraitOptions(scope, "MESSAGE");
    expect(options.map((o) => o.name)).toEqual(["CloudEvents", "TraceContext"]);
    for (const option of options) {
      const definition = def(option.name);
      expect(option).toMatchObject({ ownerLabel: "Enterprise", bundled: true });
      expect(option.spec).toEqual(definition.spec);
      // the database re-sorts the stored keys; the rows still come back in the definition's order
      expect(option.properties).toEqual(propertySummary(definition.spec));
    }
    expect(options[0].properties.map((p) => p.name)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(options[0].properties.map((p) => p.required)).toEqual([true, true, true, true, false, false, false, false]);
    expect(options[1].properties.map((p) => [p.name, p.required])).toEqual([["traceparent", true], ["tracestate", false]]);
  });

  it("a custom trait is not built in; with inline headers it lists its rows, without them it has none", async () => {
    const withHeaders = await prisma.trait.create({
      data: {
        name: "Routing", kind: "MESSAGE", tenantId,
        spec: { summary: "routing", headers: { type: "object", required: ["tenant"], properties: { tenant: { type: "string", description: "Owning tenant" }, retries: { type: "integer" } } } },
      },
    });
    const bare = await prisma.trait.create({ data: { name: "Bare", kind: "MESSAGE", tenantId } });
    const odd = await prisma.trait.create({ data: { name: "Odd", kind: "MESSAGE", tenantId, spec: ["not", "an", "object"] } });

    const options = await loadTraitOptions(scope, "MESSAGE");
    const find = (id: string) => options.find((o) => o.id === id)!;
    expect(find(withHeaders.id)).toMatchObject({ bundled: false, spec: { summary: "routing" }, properties: [
      { name: "tenant", type: "string", required: true, description: "Owning tenant" },
      { name: "retries", type: "integer", required: false },
    ] });
    expect(find(bare.id)).toMatchObject({ bundled: false, spec: {}, properties: [] });
    // a stored spec that is not an object reads as an empty one, never as an error
    expect(find(odd.id)).toMatchObject({ bundled: false, spec: {}, properties: [] });
    expect(options.map((o) => o.name)).toEqual(["Bare", "CloudEvents", "Odd", "Routing", "TraceContext"]);
  });

  it("filters by kind: the message-only built-ins are not offered for operations", async () => {
    await prisma.trait.create({ data: { name: "Audited", kind: "OPERATION", tenantId, spec: { summary: "audited" } } });
    const operations = await loadTraitOptions(scope, "OPERATION");
    expect(operations.map((o) => o.name)).toEqual(["Audited"]);
    expect(operations[0]).toMatchObject({ bundled: false, spec: { summary: "audited" }, properties: [] });
  });

  it("is limited to the tenant: another tenant's built-ins are never listed", async () => {
    const s = stamp();
    const other = await prisma.tenant.create({ data: { name: `lop2-${s}`, slug: `lop2-${s}` } });
    try {
      unwrap(await ensureBundledTraits(prisma, other.id));
      const mine = new Set((await loadTraitOptions(scope, "MESSAGE")).map((o) => o.id));
      const theirs = await prisma.trait.findMany({ where: { tenantId: other.id }, select: { id: true } });
      expect(theirs.length).toBeGreaterThan(0);
      for (const t of theirs) expect(mine.has(t.id)).toBe(false);
    } finally {
      await prisma.tenant.deleteMany({ where: { id: other.id } });
    }
  });
});
