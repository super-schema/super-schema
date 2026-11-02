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
  environmentDriftVerdict,
  markAsDeployed,
  getDeploymentStatus,
  getDeploymentOverview,
  unmarkDeployment,
  clearDeploymentStore,
  updateDriftStatus,
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

    it("clears the drift verdict an earlier check left on the environment, since it now runs the version marked", async () => {
      await markAsDeployed({ emissionTargetId: "target-1", environment: "production", versionId: "v2" }, "user-1");
      await updateDriftStatus("target-1", "production", { reason: "earlier check" }, true);
      const drifted = await getDeploymentStatus("entity-1", [{ id: "target-1", targetFormat: "avro" }]);
      expect(drifted.success && drifted.data[0].environments[0].driftStatus).toBe("drifted");

      await markAsDeployed({ emissionTargetId: "target-1", environment: "production", versionId: "v3" }, "user-1");

      const status = await getDeploymentStatus("entity-1", [{ id: "target-1", targetFormat: "avro" }]);
      expect(status.success).toBe(true);
      if (!status.success) return;
      expect(status.data[0].environments[0]).toMatchObject({ deployedVersion: "3", driftStatus: "in-sync" });
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

    describe("with the target's versions (drift compared on read)", () => {
      // Newest first, the order the stored versions are kept in.
      const versions = (...list: [number, string][]) =>
        list.map(([version, output]) => ({ version, status: "published" as const, output, generatedAt: "2026-01-01T00:00:00.000Z", entityVersion: 1 }));

      it("reads an environment as drifted when the version it runs has other output than the latest, with no check having run", async () => {
        await markAsDeployed({ emissionTargetId: "target-1", environment: "staging", versionId: "v1" }, "user-1");

        const result = await getDeploymentStatus("entity-1", [
          { id: "target-1", targetFormat: "avro", versions: versions([2, "CREATE TABLE b"], [1, "CREATE TABLE a"]) },
        ]);

        expect(result.success && result.data[0].environments[0]).toMatchObject({
          deployedVersion: "1",
          status: "DRIFTED",
          driftStatus: "drifted",
        });
      });

      it("reads an environment as in-sync when the version it runs has the output of the latest, whatever an earlier check flagged", async () => {
        await markAsDeployed({ emissionTargetId: "target-1", environment: "production", versionId: "v2" }, "user-1");
        await updateDriftStatus("target-1", "production", { reason: "earlier check" }, true);

        const result = await getDeploymentStatus("entity-1", [
          { id: "target-1", targetFormat: "avro", versions: versions([2, "CREATE TABLE a"], [1, "CREATE TABLE old"]) },
        ]);

        expect(result.success && result.data[0].environments[0]).toMatchObject({ deployedVersion: "2", status: "DEPLOYED", driftStatus: "in-sync" });
      });

      it("reads an environment whose recorded version is not in the history as drifted", async () => {
        await markAsDeployed({ emissionTargetId: "target-1", environment: "production", versionId: "v5" }, "user-1");

        const result = await getDeploymentStatus("entity-1", [
          { id: "target-1", targetFormat: "avro", versions: versions([2, "CREATE TABLE a"]) },
        ]);

        expect(result.success && result.data[0].environments[0].driftStatus).toBe("drifted");
      });
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

  describe("environmentDriftVerdict", () => {
    // Newest first, the order the stored versions are kept in.
    const versions = (...list: [number, string][]) =>
      list.map(([version, output]) => ({ version, status: "published" as const, output, generatedAt: "2026-01-01T00:00:00.000Z", entityVersion: 1 }));

    it("is in sync when the version the environment runs has the output of the latest emitted version", () => {
      const verdict = environmentDriftVerdict(versions([2, "CREATE TABLE a\n"], [1, " CREATE TABLE a"]), 1);

      expect(verdict.isDrifted).toBe(false);
      expect(verdict.driftReport).toMatchObject({ deployedVersion: "v1", latestVersion: "v2", reason: "Deployed output matches latest emitted schema" });
    });

    it("is drifted when the version the environment runs has other output than the latest emitted version", () => {
      const verdict = environmentDriftVerdict(versions([2, "CREATE TABLE b"], [1, "CREATE TABLE a"]), 1);

      expect(verdict.isDrifted).toBe(true);
      expect(verdict.driftReport).toMatchObject({ deployedVersion: "v1", latestVersion: "v2", reason: "Deployed output differs from latest emitted schema" });
    });

    it("is drifted, never in sync, when the version the environment runs is not in the schema history", () => {
      const verdict = environmentDriftVerdict(versions([2, "CREATE TABLE b"]), 1);

      expect(verdict.isDrifted).toBe(true);
      expect(verdict.driftReport).toMatchObject({ deployedVersion: "v1", latestVersion: "v2", reason: "Deployed version v1 is not in the schema history" });
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
