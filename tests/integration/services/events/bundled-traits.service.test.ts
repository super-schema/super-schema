import "dotenv/config"; // first: @/lib/db (pulled in by the trait service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { BUNDLED_TRAITS, bundledMarker, propertySummary } from "@/lib/events/bundled-traits";
import { ensureBundledTraits, ensureBundledTraitsForAllTenants } from "@/services/events/bundled-traits.service";
import { createTrait } from "@/services/events/trait.service";
import { connectTestDb, stamp, testContext, unwrap } from "./helpers";

/**
 * `ensureBundledTraits` against the real database. Every test works in a tenant of its own (the shared dev tenant is never touched),
 * and tenants are deleted afterwards: their traits and entities cascade with them.
 */
let prisma: PrismaClient;
let ctx: ServiceContext;
const tenantIds: string[] = [];

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => {
  try {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  } finally {
    await prisma.$disconnect();
  }
});

async function freshTenant(label = "bt") {
  const s = stamp();
  const tenant = await prisma.tenant.create({ data: { name: `${label}-${s}`, slug: `${label}-${s}` } });
  tenantIds.push(tenant.id);
  return tenant;
}
const tenantTraits = (tenantId: string) =>
  prisma.trait.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true, spec: true, domainId: true, productId: true, headersEntityId: true, updatedAt: true } });
const NAMES = BUNDLED_TRAITS.map((t) => t.name);

describe("ensureBundledTraits", () => {
  it("creates every built-in trait in a tenant that has none (a tenant from before this change), at tenant level, with the exact definition", async () => {
    const tenant = await freshTenant();
    expect(await tenantTraits(tenant.id)).toEqual([]);

    const result = unwrap(await ensureBundledTraits(prisma, tenant.id));
    expect(result).toEqual({ created: NAMES, skipped: [] });

    const rows = await tenantTraits(tenant.id);
    expect(rows.map((r) => r.name).sort()).toEqual([...NAMES].sort());
    for (const def of BUNDLED_TRAITS) {
      const row = rows.find((r) => r.name === def.name)!;
      expect(row).toMatchObject({ kind: "MESSAGE", domainId: null, productId: null, headersEntityId: null });
      expect(row.spec).toEqual(def.spec);
      expect(bundledMarker(row.spec)).toBe(def.id);
    }
    // the stored CloudEvents spec carries its eight properties inline, ready to show and to emit
    const ce = rows.find((r) => r.name === "CloudEvents")!;
    expect(propertySummary(ce.spec).map((p) => p.name)).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
  });

  it("is idempotent: the second run creates nothing and never renames or edits what is there", async () => {
    const tenant = await freshTenant();
    unwrap(await ensureBundledTraits(prisma, tenant.id));
    const before = await tenantTraits(tenant.id);

    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: [], skipped: [] });
    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: [], skipped: [] });

    expect(await tenantTraits(tenant.id)).toEqual(before); // same ids, names, specs and updatedAt
  });

  it("creates only what is missing and leaves the tenant's own traits alone", async () => {
    const tenant = await freshTenant();
    const mine = await prisma.trait.create({ data: { name: "Audited", kind: "OPERATION", tenantId: tenant.id, spec: { summary: "mine" } } });
    unwrap(await ensureBundledTraits(prisma, tenant.id));
    const ce = await prisma.trait.findFirstOrThrow({ where: { tenantId: tenant.id, name: "CloudEvents" } });
    await prisma.trait.delete({ where: { id: ce.id } }); // someone removed one directly in the database

    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: ["CloudEvents"], skipped: [] });
    const rows = await tenantTraits(tenant.id);
    expect(rows.map((r) => r.name).sort()).toEqual(["Audited", "CloudEvents", "TraceContext"]);
    expect(rows.find((r) => r.id === mine.id)).toMatchObject({ name: "Audited", spec: { summary: "mine" } });
  });

  it("leaves a user-made trait called CloudEvents untouched and reports the name under skipped (still creates the others)", async () => {
    const tenant = await freshTenant();
    const owner = { level: "TENANT" as const, tenantId: tenant.id };
    const custom = unwrap(
      await createTrait(owner, { name: "CloudEvents", kind: "MESSAGE", spec: { summary: "our own envelope", headers: { type: "object", properties: { ce_id: { type: "string" } } } } }, ctx)
    );
    const before = (await tenantTraits(tenant.id)).find((r) => r.id === custom.id)!;

    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: ["TraceContext"], skipped: ["CloudEvents"] });
    // asking again reports the clash again and still creates nothing
    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: [], skipped: ["CloudEvents"] });

    const rows = await tenantTraits(tenant.id);
    expect(rows.map((r) => r.name).sort()).toEqual(["CloudEvents", "TraceContext"]);
    expect(rows.find((r) => r.id === custom.id)).toEqual(before); // not renamed, not edited, not replaced
    expect(bundledMarker(rows.find((r) => r.id === custom.id)!.spec)).toBeNull();
  });

  it("a name clash is case-insensitive, like every line-unique name", async () => {
    const tenant = await freshTenant();
    await prisma.trait.create({ data: { name: "traceCONTEXT", kind: "MESSAGE", tenantId: tenant.id, spec: {} } });
    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: ["CloudEvents"], skipped: ["TraceContext"] });
    expect((await tenantTraits(tenant.id)).map((r) => r.name).sort()).toEqual(["CloudEvents", "traceCONTEXT"]);
  });

  it("a name held by something that is not a trait (an entity) is a clash too, and that asset is left alone", async () => {
    const tenant = await freshTenant();
    const entity = await prisma.entity.create({
      data: { name: "CloudEvents", slug: "cloudevents", tenantId: tenant.id, ownerId: ctx.userId, typespecSource: "model CloudEvents {\n  id: string;\n}\n" },
    });
    expect(unwrap(await ensureBundledTraits(prisma, tenant.id))).toEqual({ created: ["TraceContext"], skipped: ["CloudEvents"] });
    expect(await prisma.entity.findUniqueOrThrow({ where: { id: entity.id }, select: { name: true } })).toEqual({ name: "CloudEvents" });
    expect((await tenantTraits(tenant.id)).map((r) => r.name)).toEqual(["TraceContext"]);
  });

  it("concurrent runs create each built-in exactly once, and none of them reports the other's row as a clash", async () => {
    const tenant = await freshTenant();
    const runs = await Promise.all([1, 2, 3, 4].map(() => ensureBundledTraits(prisma, tenant.id).then(unwrap)));
    expect(runs.flatMap((r) => r.skipped)).toEqual([]);
    expect(runs.flatMap((r) => r.created).sort()).toEqual([...NAMES].sort());
    expect((await tenantTraits(tenant.id)).map((r) => r.name).sort()).toEqual([...NAMES].sort());
  });

  it("works per tenant: another tenant's traits are neither created nor read", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    unwrap(await ensureBundledTraits(prisma, a.id));
    expect(await tenantTraits(b.id)).toEqual([]);
    expect(unwrap(await ensureBundledTraits(prisma, b.id))).toEqual({ created: NAMES, skipped: [] });
    expect((await tenantTraits(a.id)).length).toBe(NAMES.length);
  });

  it("creates tenant-level traits only: nothing at domain or product level", async () => {
    const tenant = await freshTenant();
    const domain = await prisma.domain.create({ data: { name: `d-${stamp()}`, slug: `d-${stamp()}`, tenantId: tenant.id } });
    unwrap(await ensureBundledTraits(prisma, tenant.id));
    expect(await prisma.trait.count({ where: { tenantId: tenant.id, OR: [{ domainId: { not: null } }, { productId: { not: null } }] } })).toBe(0);
    expect(await prisma.trait.count({ where: { domainId: domain.id } })).toBe(0);
  });

  it("an unknown tenant is NOT_FOUND and creates nothing", async () => {
    const missing = `missing-${stamp()}`;
    const result = await ensureBundledTraits(prisma, missing);
    expect(!result.success && result.error.code).toBe("NOT_FOUND");
    expect(await prisma.trait.count({ where: { tenantId: missing } })).toBe(0);
  });

  it("writes no audit row: installing a built-in has no acting user", async () => {
    const tenant = await freshTenant();
    unwrap(await ensureBundledTraits(prisma, tenant.id));
    const created = await prisma.trait.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
    expect(created.length).toBe(NAMES.length);
    expect(await prisma.auditLog.count({ where: { entityId: { in: created.map((t) => t.id) } } })).toBe(0);
  });
});

describe("ensureBundledTraitsForAllTenants", () => {
  it("visits the given tenants, lists what each got, and keeps going past a tenant that fails", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await prisma.trait.create({ data: { name: "CloudEvents", kind: "MESSAGE", tenantId: b.id, spec: { summary: "custom" } } });
    const missing = `missing-${stamp()}`;

    const result = unwrap(await ensureBundledTraitsForAllTenants(prisma, [a.id, b.id, missing]));
    expect(result.tenants).toBe(3);
    expect(result.created).toEqual([{ tenantId: a.id, names: NAMES }, { tenantId: b.id, names: ["TraceContext"] }]);
    expect(result.skipped).toEqual([{ tenantId: b.id, names: ["CloudEvents"] }]);
    expect(result.failed).toEqual([{ tenantId: missing, code: "NOT_FOUND" }]);

    // a second pass finds nothing left to do (the clash stays reported)
    const again = unwrap(await ensureBundledTraitsForAllTenants(prisma, [a.id, b.id]));
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([{ tenantId: b.id, names: ["CloudEvents"] }]);
    expect(again.failed).toEqual([]);
  });
});
