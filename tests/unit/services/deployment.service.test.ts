import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store to simulate Prisma behavior
// ---------------------------------------------------------------------------

let deploymentRows: Array<{
  id: string;
  entityId: string;
  target: string;
  environment: string;
  version: number;
  status: "DEPLOYED" | "STAGED" | "UNKNOWN";
  driftReport: Record<string, unknown> | null;
  isDrifted: boolean;
  deployedBy: string | null;
  deployedAt: Date;
  updatedAt: Date;
}> = [];

let nextId = 1;

vi.mock("@/lib/db", () => ({
  prisma: {
    deploymentRecord: {
      upsert: vi.fn().mockImplementation(async (args: {
        where: { entityId_target_environment: { entityId: string; target: string; environment: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { entityId, target, environment } = args.where.entityId_target_environment;
        const existingIndex = deploymentRows.findIndex(
          (r) => r.entityId === entityId && r.target === target && r.environment === environment
        );
        if (existingIndex >= 0) {
          deploymentRows[existingIndex] = {
            ...deploymentRows[existingIndex],
            ...(args.update as Record<string, unknown>),
            updatedAt: new Date(),
          } as typeof deploymentRows[0];
          return deploymentRows[existingIndex];
        }
        const row = {
          id: `deploy-${nextId++}`,
          ...(args.create as Record<string, unknown>),
          driftReport: null,
          isDrifted: false,
          updatedAt: new Date(),
        } as typeof deploymentRows[0];
        deploymentRows.push(row);
        return row;
      }),
      findMany: vi.fn().mockImplementation(async (args: { where: { target?: string | { in: string[] }; environment?: string } }) => {
        let rows = deploymentRows;
        if (typeof args.where.target === "string") {
          rows = rows.filter((r) => r.target === args.where.target);
        } else if (args.where.target && "in" in args.where.target) {
          rows = rows.filter((r) => (args.where.target as { in: string[] }).in.includes(r.target));
        }
        if (args.where.environment) {
          rows = rows.filter((r) => r.environment === args.where.environment);
        }
        return rows;
      }),
      deleteMany: vi.fn().mockImplementation(async (args: { where: { target: string; environment: string } }) => {
        const before = deploymentRows.length;
        deploymentRows = deploymentRows.filter(
          (r) => !(r.target === args.where.target && r.environment === args.where.environment)
        );
        return { count: before - deploymentRows.length };
      }),
      update: vi.fn().mockImplementation(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const index = deploymentRows.findIndex((r) => r.id === args.where.id);
        if (index === -1) throw new Error("Not found");
        deploymentRows[index] = {
          ...deploymentRows[index],
          ...(args.data as Record<string, unknown>),
          updatedAt: new Date(),
        } as typeof deploymentRows[0];
        return deploymentRows[index];
      }),
    },
  },
}));

import {
  markAsDeployed,
  getDeploymentStatus,
  getDeploymentOverview,
  unmarkDeployment,
  clearDeploymentStore,
} from "@/services/deployment.service";

describe("Deployment Service", () => {
  beforeEach(() => {
    deploymentRows = [];
    nextId = 1;
    vi.clearAllMocks();
    clearDeploymentStore();
  });

  describe("markAsDeployed", () => {
    it("creates deployment tracking record with correct status", async () => {
      const result = await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toMatchObject({
        emissionTargetId: "target-1",
        environment: "production",
        status: "DEPLOYED",
        deployedVersionId: "3",
        markedDeployedBy: "user-1",
      });
      expect(result.data.markedDeployedAt).toBeTruthy();
    });

    it("upserts — updates existing record for same target+environment", async () => {
      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v2",
        },
        "user-1"
      );

      const result = await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.deployedVersionId).toBe("3");
    });

    it('sets status to "STAGED" when deployed version differs from emitted version', async () => {
      const result = await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v2",
          currentEmittedVersionId: "v3",
        },
        "user-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe("STAGED");
    });

    it('sets status to "DEPLOYED" when deployed version matches emitted version', async () => {
      const result = await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
          currentEmittedVersionId: "v3",
        },
        "user-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe("DEPLOYED");
    });

    it("creates different records for different environments", async () => {
      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "staging",
          versionId: "v4",
        },
        "user-1"
      );

      const status = await getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro" },
      ]);

      expect(status.success).toBe(true);
      if (!status.success) return;
      expect(status.data[0].environments).toHaveLength(2);
    });
  });

  describe("getDeploymentStatus", () => {
    it("returns all targets with environment details", async () => {
      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = await getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro", emittedVersion: "v3" },
        { id: "target-2", targetFormat: "bigquery-ddl", emittedVersion: "v2" },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toHaveLength(2);
      expect(result.data[0].environments).toHaveLength(1);
      expect(result.data[1].environments).toHaveLength(0);
    });

    it("returns empty environments for targets without tracking", async () => {
      const result = await getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro" },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data[0].environments).toHaveLength(0);
    });
  });

  describe("getDeploymentOverview", () => {
    const entities = [
      {
        entityId: "ent-1",
        entityName: "User",
        domain: "core",
        currentVersion: "v3",
        targets: [{ id: "target-1", format: "avro" }],
      },
      {
        entityId: "ent-2",
        entityName: "Order",
        domain: "commerce",
        currentVersion: "v1",
        targets: [{ id: "target-2", format: "bigquery-ddl" }],
      },
    ];

    it("returns all entities with correct deployment data", async () => {
      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = await getDeploymentOverview(entities);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(2);
      expect(result.data.total).toBe(2);
    });

    it("applies domain filter correctly", async () => {
      const result = await getDeploymentOverview(entities, { domain: "core" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("User");
    });

    it("applies driftStatus filter correctly", async () => {
      // No deployments -> all unknown
      const result = await getDeploymentOverview(entities, {
        driftStatus: "unknown",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(2);
    });

    it("applies targetFormat filter correctly", async () => {
      const result = await getDeploymentOverview(entities, {
        targetFormat: "avro",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("User");
    });

    it("supports pagination (offset + limit)", async () => {
      const result = await getDeploymentOverview(entities, undefined, 0, 1);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.total).toBe(2);
    });

    it("supports offset pagination", async () => {
      const result = await getDeploymentOverview(entities, undefined, 1, 10);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("Order");
    });
  });

  describe("unmarkDeployment", () => {
    it("removes tracking record", async () => {
      await markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = await unmarkDeployment("target-1", "production");
      expect(result.success).toBe(true);

      // Verify it's gone
      const status = await getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro" },
      ]);
      expect(status.success).toBe(true);
      if (!status.success) return;
      expect(status.data[0].environments).toHaveLength(0);
    });

    it("succeeds even if record does not exist", async () => {
      const result = await unmarkDeployment("nonexistent", "production");
      expect(result.success).toBe(true);
    });
  });
});
