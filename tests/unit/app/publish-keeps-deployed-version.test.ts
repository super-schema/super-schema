/**
 * Publishing a new schema version never changes the versions already there: the deployed one stays deployed (the schema still records which
 * version is deployed), a published version is never turned back into a draft, and only the new version changes. Deploying a version
 * un-deploys the one that was deployed before it, back to `published` (it was published before it was deployed, so it keeps that identity),
 * so a rollback to an older published version leaves exactly one deployed version. The publish, the deploy and the environments' drift checks
 * run through the real actions over one stored `schemaVersions` list and an in-memory deployment-record table, so the sequences are the ones a
 * user goes through. Prisma is a stateful in-memory fake (the repo's pattern for the entity actions).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@/types/schema-version";

const h = vi.hoisted(() => ({
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    deploymentRecord: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "user-1", email: "test@example.com", name: "Test User" } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }),
}));

import {
  checkTargetDriftAction,
  deploySchemaAction,
  getEntityDeploymentStatusAction,
  markEntityDeployedAction,
  publishSchemaAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const TARGET = "bigquery";
const TARGET_ID = `ent-1:${TARGET}`;
const T0 = "2026-04-05T10:00:00.000Z";
const T1 = "2026-04-05T11:00:00.000Z";
const T2 = "2026-04-05T12:00:00.000Z";

/** The stored entity: its metadata is what the actions read and write. */
let stored: Record<string, unknown> = {};

/** The deployment records of the entity's targets, one per environment, as the Prisma model holds them. */
type RecordRow = {
  id: string;
  entityId: string;
  target: string;
  environment: string;
  version: number;
  status: string;
  driftReport: unknown;
  isDrifted: boolean;
  deployedBy: string | null;
  deployedAt: Date;
  updatedAt: Date;
};
let records: RecordRow[] = [];

function versionRow(version: number, status: SchemaVersion["status"], extra: Partial<SchemaVersion> = {}): SchemaVersion {
  return { version, status, output: `CREATE TABLE v${version}`, generatedAt: T0, entityVersion: 1, ...extra };
}

/** Seeds the versions of `TARGET`, newest first (the order the generation writes them in). */
function seed(versions: SchemaVersion[]) {
  stored = { name: "Order", schemaVersions: { [TARGET]: versions } };
}

const versionsNow = (): SchemaVersion[] => (stored.schemaVersions as Record<string, SchemaVersion[]>)[TARGET];
const byNumber = (version: number): SchemaVersion => versionsNow().find((v) => v.version === version)!;
const statusOf = (version: number) => byNumber(version).status;

/** A new draft generated on top of the stored versions (newest first), with the output given: what a generation writes. */
function generate(output: string) {
  const list = versionsNow();
  const next = Math.max(...list.map((v) => v.version)) + 1;
  stored = { ...stored, schemaVersions: { [TARGET]: [versionRow(next, "draft", { output, generatedAt: T2 }), ...list] } };
}

/** The records the deployment service's queries match: by target (one, or several with `in`), optionally by environment. */
function recordsWhere(where: { target?: string | { in: string[] }; environment?: string }): RecordRow[] {
  return records.filter(
    (row) =>
      (typeof where.target === "string" ? row.target === where.target : where.target === undefined || where.target.in.includes(row.target)) &&
      (where.environment === undefined || row.environment === where.environment)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  records = [];
  h.prisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  h.prisma.entity.findUnique.mockImplementation(async () => ({ id: "ent-1", tenantId: "tenant-1", metadata: stored }));
  h.prisma.entity.update.mockImplementation(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
    stored = data.metadata;
    return { id: "ent-1" };
  });
  h.prisma.deploymentRecord.upsert.mockImplementation(async (args: {
    where: { entityId_target_environment: { entityId: string; target: string; environment: string } };
    create: Partial<RecordRow>;
    update: Partial<RecordRow>;
  }) => {
    const { entityId, target, environment } = args.where.entityId_target_environment;
    const i = records.findIndex((r) => r.entityId === entityId && r.target === target && r.environment === environment);
    if (i >= 0) {
      records[i] = { ...records[i], ...args.update, updatedAt: new Date() } as RecordRow;
      return records[i];
    }
    const row = { id: `rec-${records.length + 1}`, driftReport: null, isDrifted: false, updatedAt: new Date(), ...args.create } as RecordRow;
    records.push(row);
    return row;
  });
  h.prisma.deploymentRecord.findMany.mockImplementation(async (args: { where: { target?: string | { in: string[] }; environment?: string } }) =>
    recordsWhere(args.where).map((row) => ({ ...row }))
  );
  h.prisma.deploymentRecord.update.mockImplementation(async (args: { where: { id: string }; data: Partial<RecordRow> }) => {
    const i = records.findIndex((r) => r.id === args.where.id);
    records[i] = { ...records[i], ...args.data, updatedAt: new Date() } as RecordRow;
    return records[i];
  });
});

describe("publishSchemaAction after a version was deployed", () => {
  it("publishing a new version keeps an earlier published version published, never a draft", async () => {
    seed([versionRow(2, "draft"), versionRow(1, "published", { publishedAt: T1 })]);

    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });

    expect(statusOf(2)).toBe("published");
    expect(statusOf(1)).toBe("published");
  });

  it("publishing a new version leaves the deployed version deployed, and changes nothing on it", async () => {
    const deployed = versionRow(1, "deployed", { publishedAt: T1, deployedAt: T2 });
    seed([versionRow(2, "draft"), deployed]);

    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });

    expect(byNumber(1)).toEqual(deployed);
    expect(statusOf(2)).toBe("published");
    expect(versionsNow().some((v) => v.status === "draft")).toBe(false);
  });

  it("a publish refused for a draft reference leaves the deployed version and the draft as they were", async () => {
    const resolution = {
      mode: "draft" as const,
      preview: true,
      entities: [
        { ref: { entityId: "ent-1", domain: "sales", product: "orders", entity: "Order" }, source: "draft" as const },
        { ref: { entityId: "ent-2", domain: "sales", product: "orders", entity: "Address" }, source: "draft" as const },
      ],
    };
    seed([versionRow(2, "draft", { resolution }), versionRow(1, "deployed", { publishedAt: T1, deployedAt: T2 })]);

    expect(await publishSchemaAction("ent-1", TARGET, 2)).toMatchObject({ code: "PREVIEW_NOT_PUBLISHABLE" });

    expect(statusOf(1)).toBe("deployed");
    expect(statusOf(2)).toBe("draft");
    expect(h.prisma.entity.update).not.toHaveBeenCalled();
  });

  it("the drift check judges each environment against the version it runs, and the publish leaves the records on the versions they run", async () => {
    seed([versionRow(1, "published", { publishedAt: T1, output: "CREATE TABLE v1" })]);
    expect(await deploySchemaAction("ent-1", TARGET, 1)).toEqual({ success: true });
    expect(await markEntityDeployedAction("ent-1", TARGET_ID, "staging")).toEqual({ success: true }); // staging runs v1

    generate("CREATE TABLE v2 with a new column");
    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });
    expect(await markEntityDeployedAction("ent-1", TARGET_ID, "production")).toEqual({ success: true }); // production runs v2

    expect(statusOf(1)).toBe("deployed");
    expect(records.map((row) => [row.environment, row.version])).toEqual([
      ["staging", 1],
      ["production", 2],
    ]);

    const check = await checkTargetDriftAction("ent-1", TARGET_ID);
    if ("error" in check) throw new Error(check.error);
    const environments = check.data.find((t) => t.targetId === TARGET_ID)?.environments ?? [];
    expect(environments.find((e) => e.name === "staging")?.driftStatus).toBe("drifted");
    expect(environments.find((e) => e.name === "production")?.driftStatus).toBe("in-sync");
  });

  it("with no drift check run, an environment on an older version reads as drifted once the new version is published", async () => {
    seed([versionRow(1, "published", { publishedAt: T1, output: "CREATE TABLE v1" })]);
    expect(await deploySchemaAction("ent-1", TARGET, 1)).toEqual({ success: true });
    expect(await markEntityDeployedAction("ent-1", TARGET_ID, "staging")).toEqual({ success: true }); // staging runs v1

    generate("CREATE TABLE v2 with a new column");
    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });

    const status = await getEntityDeploymentStatusAction("ent-1");
    if ("error" in status) throw new Error(status.error);
    const staging = status.data.find((t) => t.targetId === TARGET_ID)?.environments.find((e) => e.name === "staging");
    expect(staging).toMatchObject({ deployedVersion: "1", driftStatus: "drifted" });
    expect(statusOf(1)).toBe("deployed");
  });

  it("the publish-after-deploy sequence leaves exactly one deployed version, the one deployed last", async () => {
    seed([versionRow(2, "draft"), versionRow(1, "published", { publishedAt: T0 })]);

    expect(await deploySchemaAction("ent-1", TARGET, 1)).toEqual({ success: true });
    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });
    expect(await deploySchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });

    expect(statusOf(2)).toBe("deployed");
    expect(statusOf(1)).toBe("published");
    expect(versionsNow().filter((v) => v.status === "deployed")).toHaveLength(1);
  });

  it("rolling back to an older published version leaves exactly one deployed version, the one deployed last", async () => {
    seed([versionRow(2, "draft"), versionRow(1, "published", { publishedAt: T0 })]);

    expect(await deploySchemaAction("ent-1", TARGET, 1)).toEqual({ success: true });
    expect(await publishSchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });
    expect(await deploySchemaAction("ent-1", TARGET, 2)).toEqual({ success: true });
    expect(await deploySchemaAction("ent-1", TARGET, 1)).toEqual({ success: true });

    expect(statusOf(1)).toBe("deployed");
    expect(statusOf(2)).toBe("published");
    expect(versionsNow().filter((v) => v.status === "deployed")).toHaveLength(1);
  });
});
