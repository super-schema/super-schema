import { describe, it, expect, beforeEach } from "vitest";
import {
  markAsDeployed,
  getDeploymentStatus,
  getDeploymentOverview,
  unmarkDeployment,
  clearDeploymentStore,
} from "@/services/deployment.service";

describe("Deployment Service", () => {
  beforeEach(() => {
    clearDeploymentStore();
  });

  describe("markAsDeployed", () => {
    it("creates deployment tracking record with correct status", () => {
      const result = markAsDeployed(
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
        deployedVersionId: "v3",
        markedDeployedBy: "user-1",
      });
      expect(result.data.markedDeployedAt).toBeTruthy();
    });

    it("upserts — updates existing record for same target+environment", () => {
      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v2",
        },
        "user-1"
      );

      const result = markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.deployedVersionId).toBe("v3");
    });

    it('sets status to "STAGED" when deployed version differs from emitted version', () => {
      const result = markAsDeployed(
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

    it('sets status to "DEPLOYED" when deployed version matches emitted version', () => {
      const result = markAsDeployed(
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

    it("creates different records for different environments", () => {
      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "staging",
          versionId: "v4",
        },
        "user-1"
      );

      const status = getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro" },
      ]);

      expect(status.success).toBe(true);
      if (!status.success) return;
      expect(status.data[0].environments).toHaveLength(2);
    });
  });

  describe("getDeploymentStatus", () => {
    it("returns all targets with environment details", () => {
      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro", emittedVersion: "v3" },
        { id: "target-2", targetFormat: "bigquery-ddl", emittedVersion: "v2" },
      ]);

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data).toHaveLength(2);
      expect(result.data[0].environments).toHaveLength(1);
      expect(result.data[1].environments).toHaveLength(0);
    });

    it("returns empty environments for targets without tracking", () => {
      const result = getDeploymentStatus("entity-1", [
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

    it("returns all entities with correct deployment data", () => {
      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = getDeploymentOverview(entities);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(2);
      expect(result.data.total).toBe(2);
    });

    it("applies domain filter correctly", () => {
      const result = getDeploymentOverview(entities, { domain: "core" });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("User");
    });

    it("applies driftStatus filter correctly", () => {
      // No deployments → all unknown
      const result = getDeploymentOverview(entities, {
        driftStatus: "unknown",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(2);
    });

    it("applies targetFormat filter correctly", () => {
      const result = getDeploymentOverview(entities, {
        targetFormat: "avro",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("User");
    });

    it("supports pagination (offset + limit)", () => {
      const result = getDeploymentOverview(entities, undefined, 0, 1);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.total).toBe(2);
    });

    it("supports offset pagination", () => {
      const result = getDeploymentOverview(entities, undefined, 1, 10);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rows).toHaveLength(1);
      expect(result.data.rows[0].entityName).toBe("Order");
    });
  });

  describe("unmarkDeployment", () => {
    it("removes tracking record", () => {
      markAsDeployed(
        {
          emissionTargetId: "target-1",
          environment: "production",
          versionId: "v3",
        },
        "user-1"
      );

      const result = unmarkDeployment("target-1", "production");
      expect(result.success).toBe(true);

      // Verify it's gone
      const status = getDeploymentStatus("entity-1", [
        { id: "target-1", targetFormat: "avro" },
      ]);
      expect(status.success).toBe(true);
      if (!status.success) return;
      expect(status.data[0].environments).toHaveLength(0);
    });

    it("succeeds even if record does not exist", () => {
      const result = unmarkDeployment("nonexistent", "production");
      expect(result.success).toBe(true);
    });
  });
});
