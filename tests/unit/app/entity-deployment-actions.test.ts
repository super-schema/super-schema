/**
 * Tests for the entity Deployments tab server-action layer:
 * getEntityDeploymentStatusAction, markEntityDeployedAction, checkTargetDriftAction.
 *
 * Mocks NextAuth and a stateful in-memory Prisma (entity + deploymentRecord),
 * exercising the real deployment.service alongside the actions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  type Row = {
    id: string;
    entityId: string;
    target: string;
    environment: string;
    version: number;
    status: string;
    driftReport: Record<string, unknown> | null;
    isDrifted: boolean;
    deployedBy: string | null;
    deployedAt: Date;
    updatedAt: Date;
  };
  const rows: Row[] = [];
  const counter = { n: 1 };
  const entity = { findUnique: vi.fn(), update: vi.fn() };

  const deploymentRecord = {
    upsert: vi.fn(async (args: {
      where: { entityId_target_environment: { entityId: string; target: string; environment: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const { entityId, target, environment } = args.where.entityId_target_environment;
      const i = rows.findIndex((r) => r.entityId === entityId && r.target === target && r.environment === environment);
      if (i >= 0) {
        rows[i] = { ...rows[i], ...args.update, updatedAt: new Date() } as Row;
        return rows[i];
      }
      const row = { id: `deploy-${counter.n++}`, driftReport: null, isDrifted: false, updatedAt: new Date(), ...args.create } as Row;
      rows.push(row);
      return row;
    }),
    findMany: vi.fn(async (args: { where: { target?: string | { in: string[] }; environment?: string } }) => {
      let out = rows.slice();
      if (typeof args.where.target === "string") out = out.filter((r) => r.target === args.where.target);
      else if (args.where.target && "in" in args.where.target) {
        const inc = (args.where.target as { in: string[] }).in;
        out = out.filter((r) => inc.includes(r.target));
      }
      if (args.where.environment) out = out.filter((r) => r.environment === args.where.environment);
      return out;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const i = rows.findIndex((r) => r.id === args.where.id);
      if (i === -1) throw new Error("Not found");
      rows[i] = { ...rows[i], ...args.data, updatedAt: new Date() } as Row;
      return rows[i];
    }),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };

  return {
    prisma: { entity, deploymentRecord },
    entity,
    reset: () => {
      rows.length = 0;
      counter.n = 1;
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "test@example.com", name: "Test User" },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));

import {
  getEntityDeploymentStatusAction,
  markEntityDeployedAction,
  checkTargetDriftAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const ENTITY_ID = "entity-1";

function metadataWith(schemaVersions: Record<string, unknown>) {
  return { metadata: { schemaVersions }, tenantId: "tenant-1" };
}
function version(v: number, status: string, output: string) {
  return { version: v, status, output, generatedAt: "2026-01-01T00:00:00.000Z", entityVersion: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
});

describe("getEntityDeploymentStatusAction", () => {
  it("derives one target per generated format from schemaVersions", async () => {
    h.entity.findUnique.mockResolvedValue(
      metadataWith({
        postgresql: [version(2, "deployed", "A"), version(1, "draft", "A")],
        avro: [version(1, "draft", "{}")],
      })
    );

    const res = await getEntityDeploymentStatusAction(ENTITY_ID);
    if ("error" in res) throw new Error(res.error);

    const ids = res.data.map((t) => t.targetId).sort();
    expect(ids).toEqual([`${ENTITY_ID}:avro`, `${ENTITY_ID}:postgresql`]);
    const pg = res.data.find((t) => t.targetId === `${ENTITY_ID}:postgresql`);
    expect(pg?.emittedVersion).toBe("v2");
  });

  it("returns an error when the entity is missing", async () => {
    h.entity.findUnique.mockResolvedValue(null);
    const res = await getEntityDeploymentStatusAction(ENTITY_ID);
    expect(res).toEqual({ error: "Entity not found", code: "NOT_FOUND" });
  });
});

describe("markEntityDeployedAction", () => {
  it("records the latest version as deployed in an environment", async () => {
    h.entity.findUnique.mockResolvedValue(
      metadataWith({ postgresql: [version(3, "deployed", "A"), version(2, "draft", "A")] })
    );

    const targetId = `${ENTITY_ID}:postgresql`;
    const marked = await markEntityDeployedAction(ENTITY_ID, targetId, "production");
    expect(marked).toEqual({ success: true });

    const status = await getEntityDeploymentStatusAction(ENTITY_ID);
    if ("error" in status) throw new Error(status.error);
    const prod = status.data
      .find((t) => t.targetId === targetId)
      ?.environments.find((e) => e.name === "production");
    expect(prod?.deployedVersion).toBe("3");
    expect(prod?.driftStatus).toBe("in-sync");
  });

  it("errors when the target has no emitted version", async () => {
    h.entity.findUnique.mockResolvedValue(metadataWith({}));
    const res = await markEntityDeployedAction(ENTITY_ID, `${ENTITY_ID}:postgresql`, "production");
    expect("error" in res).toBe(true);
  });
});

describe("checkTargetDriftAction", () => {
  it("flags drift when deployed output differs from latest emitted output", async () => {
    h.entity.findUnique.mockResolvedValue(
      metadataWith({ postgresql: [version(2, "draft", "NEW"), version(1, "deployed", "OLD")] })
    );
    const targetId = `${ENTITY_ID}:postgresql`;
    await markEntityDeployedAction(ENTITY_ID, targetId, "production");

    const res = await checkTargetDriftAction(ENTITY_ID, targetId);
    if ("error" in res) throw new Error(res.error);
    const prod = res.data
      .find((t) => t.targetId === targetId)
      ?.environments.find((e) => e.name === "production");
    expect(prod?.driftStatus).toBe("drifted");
  });

  it("reports in-sync when deployed output matches latest output", async () => {
    h.entity.findUnique.mockResolvedValue(
      metadataWith({ postgresql: [version(2, "deployed", "SAME"), version(1, "draft", "SAME")] })
    );
    const targetId = `${ENTITY_ID}:postgresql`;
    await markEntityDeployedAction(ENTITY_ID, targetId, "production");

    const res = await checkTargetDriftAction(ENTITY_ID, targetId);
    if ("error" in res) throw new Error(res.error);
    const prod = res.data
      .find((t) => t.targetId === targetId)
      ?.environments.find((e) => e.name === "production");
    expect(prod?.driftStatus).toBe("in-sync");
  });
});
