/**
 * The compliance queries against a real database (PGlite with every migration), where the SQL is what the point is: a legacy classification
 * level in a field's decorators is found by the Query's classification filter, a protection filter pages over the whole matching set (the total,
 * the pages and the rows agree) and its export holds every match, a TypeSpec source's @anonymization is the field's anonymization for the Gaps
 * tab, the Audit Trail's `to` is exclusive (a whole last day is in), and rows written in the same instant page once each.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { detectGaps, exportFields, queryAuditTrail, queryFields } from "@/services/compliance.service";
import { assign } from "../../helpers/access-mocks";
import type { ServiceContext } from "@/types/service-context";

const db = () => holder.db!.prisma;

afterAll(async () => {
  await holder.db?.close();
});

const SIX_MONTHS = { strategy: "age-based", period: 6, periodUnit: "months", referenceField: "created_at", action: "delete" };

/** A tenant with a domain, a product, a user (the audit rows' author) and the context a compliance officer of the tenant has. */
async function tenantWithOfficer(label: string) {
  const tenant = await db().tenant.create({ data: { name: label, slug: `${label}-slug` } });
  const domain = await db().domain.create({ data: { tenantId: tenant.id, name: "Commerce", slug: `${label}-commerce` } });
  const product = await db().product.create({ data: { domainId: domain.id, name: "Orders", slug: `${label}-orders` } });
  const user = await db().user.create({ data: { email: `${label}@example.test`, name: "Officer" } });
  const ctx: ServiceContext = {
    userId: user.id,
    userRole: "COMPLIANCE_OFFICER",
    assignments: [assign.tenant("COMPLIANCE_OFFICER", tenant.id)],
    tenantId: tenant.id,
    prisma: db() as unknown as ServiceContext["prisma"],
  };
  return { tenant, domain, product, user, ctx };
}

async function entityIn(f: Awaited<ReturnType<typeof tenantWithOfficer>>, name: string, metadata: Prisma.InputJsonValue = {}) {
  return db().entity.create({
    data: { name, slug: name.toLowerCase(), tenantId: f.tenant.id, domainId: f.domain.id, productId: f.product.id, ownerId: f.user.id, metadata },
  });
}

describe("the Query's classification filter", () => {
  let f: Awaited<ReturnType<typeof tenantWithOfficer>>;
  beforeAll(async () => {
    f = await tenantWithOfficer("classify");
    const entity = await entityIn(f, "Customer");
    await db().field.createMany({
      data: [
        { entityId: entity.id, name: "column_pii", slug: "column_pii", type: "string", classification: "PII", sortOrder: 0 },
        // a row with no column value: the level is in its decorators, the shape the list shows and the Gaps rule reads
        { entityId: entity.id, name: "legacy_pii", slug: "legacy_pii", type: "string", classification: null, sortOrder: 1, decorators: { classification: { level: "PII" } } },
        { entityId: entity.id, name: "public", slug: "public", type: "string", classification: "PUBLIC", sortOrder: 2 },
      ],
    });
  });

  it("finds the rows whose column says the level, and those whose decorators say it (the same rows the list shows a classification for)", async () => {
    const result = await queryFields({ classifications: ["PII"] }, { page: 1, pageSize: 25, sortBy: "fieldName", sortOrder: "asc" }, f.ctx);

    expect(result.success && result.data.total).toBe(2);
    expect(result.success && result.data.fields.map((field) => [field.fieldName, field.classification])).toEqual([
      ["column_pii", "PII"],
      ["legacy_pii", "PII"],
    ]);
  });
});

describe("the Gaps tab reads the TypeSpec source's @anonymization", () => {
  let f: Awaited<ReturnType<typeof tenantWithOfficer>>;
  beforeAll(async () => {
    f = await tenantWithOfficer("gaps");
    const entity = await entityIn(f, "Account", { retentionPolicy: SIX_MONTHS });
    await db().field.createMany({
      data: [
        // the sync writes a source's @anonymization(AnonymizationStrategy.hash) to decorators.governance.anonymization
        { entityId: entity.id, name: "from_source", slug: "from_source", type: "string", classification: "PII", sortOrder: 0, decorators: { governance: { anonymization: "hash" } } },
        { entityId: entity.id, name: "no_method", slug: "no_method", type: "string", classification: "PII", sortOrder: 1, decorators: {} },
      ],
    });
  });

  it("the PII field with a source's anonymization has no gap; the one with none is the CRITICAL gap", async () => {
    const result = await detectGaps({}, f.ctx);

    expect(result.success && result.data.gaps.map((gap) => `${gap.fieldName}:${gap.gapType}`).sort()).toEqual(["no_method:PII_NO_ANONYMIZATION"]);
  });
});

describe("a protection filter pages over the whole set of matches", () => {
  let f: Awaited<ReturnType<typeof tenantWithOfficer>>;
  beforeAll(async () => {
    f = await tenantWithOfficer("paging");
    const short = await entityIn(f, "Short", { retentionPolicy: SIX_MONTHS });
    const long = await entityIn(f, "Long");
    // sixty fields in name order; the 3rd, the 10th and the 40th are in the entity that keeps its data six months
    await db().field.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        entityId: i === 2 || i === 9 || i === 39 ? short.id : long.id,
        name: `f${String(i).padStart(2, "0")}`,
        slug: `f${String(i).padStart(2, "0")}`,
        type: "string",
        classification: "PII",
        sortOrder: i,
      })),
    });
  });

  it("the total is the matches, every page holds matches only, and a page past the last is empty with the same total", async () => {
    const sort = { page: 1, pageSize: 2, sortBy: "fieldName", sortOrder: "asc" } as const;
    const names = async (page: number) => {
      const result = await queryFields({ retention: "lt_1_year" }, { ...sort, page }, f.ctx);
      return { total: result.success ? result.data.total : -1, names: result.success ? result.data.fields.map((field) => field.fieldName) : [] };
    };

    expect(await names(1)).toEqual({ total: 3, names: ["f02", "f09"] });
    expect(await names(2)).toEqual({ total: 3, names: ["f39"] });
    expect(await names(3)).toEqual({ total: 3, names: [] });
  });
});

describe("a protection filter's export holds every match", () => {
  it("past the first page, with the export recorded in the tenant's audit trail", async () => {
    const f = await tenantWithOfficer("export");
    const short = await entityIn(f, "Short", { retentionPolicy: SIX_MONTHS });
    const long = await entityIn(f, "Long");
    await db().field.createMany({
      data: Array.from({ length: 1_300 }, (_, i) => ({
        entityId: i % 13 === 0 ? long.id : short.id,
        name: `g${String(i).padStart(4, "0")}`,
        slug: `g${String(i).padStart(4, "0")}`,
        type: "string",
        classification: "PII",
        sortOrder: i,
      })),
    });

    const result = await exportFields({ retention: "lt_1_year" }, { sortBy: "fieldName", sortOrder: "asc" }, f.ctx);

    // the 1,300 fields, 100 of them in the entity with no policy: 1,200 match
    expect(result.success && result.data.total).toBe(1_200);
    expect(result.success && result.data.truncated).toBe(false);
    expect(result.success && result.data.fields.length).toBe(1_200);
    expect(result.success && result.data.fields[0].fieldName).toBe("g0001");
    const audited = await db().auditLog.findFirst({ where: { tenantId: f.tenant.id, action: "compliance.export" } });
    expect(audited?.afterState).toMatchObject({ rows: 1_200, total: 1_200, truncated: false });
  }, 60_000);
});

describe("the Audit Trail's dates and its order", () => {
  let f: Awaited<ReturnType<typeof tenantWithOfficer>>;
  const SAME_INSTANT = new Date(2026, 9, 15, 12, 0, 0);
  beforeAll(async () => {
    f = await tenantWithOfficer("audit");
    const rows = [
      { timestamp: new Date(2026, 9, 1, 0, 0, 0), entityId: "first-day" },
      { timestamp: new Date(2026, 9, 31, 23, 30, 0), entityId: "last-day-late" },
      { timestamp: new Date(2026, 10, 1, 0, 0, 0), entityId: "next-day" },
      ...Array.from({ length: 5 }, (_, i) => ({ timestamp: SAME_INSTANT, entityId: `tie-${i}` })),
    ];
    for (const row of rows) {
      await db().auditLog.create({
        data: { action: "UPDATE", entityType: "Field", entityId: row.entityId, userId: f.user.id, timestamp: row.timestamp, tenantId: f.tenant.id },
      });
    }
  });

  it("a range from the first local midnight to the next day's local midnight holds the whole last day, and not the day after", async () => {
    const result = await queryAuditTrail(
      { dateRange: { from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) } },
      { page: 1, pageSize: 50 },
      f.ctx
    );

    const ids = result.success ? result.data.entries.map((entry) => entry.entityId) : [];
    expect(ids).toContain("first-day");
    expect(ids).toContain("last-day-late");
    expect(ids).not.toContain("next-day");
  });

  it("rows written in the same instant page once each, across every page", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const result = await queryAuditTrail({ entityName: "tie-" }, { page, pageSize: 2 }, f.ctx);
      if (result.success) seen.push(...result.data.entries.map((entry) => entry.entityId));
    }

    expect(seen.sort()).toEqual(["tie-0", "tie-1", "tie-2", "tie-3", "tie-4"]);
  });
});
