import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store to simulate Prisma behavior
// ---------------------------------------------------------------------------

let emissionRows: Array<{
  id: string;
  entityId: string;
  target: string;
  emittedVersion: number | null;
  stagedVersion: number | null;
  lastEmittedAt: Date | null;
  status: "CURRENT" | "STAGED" | "BEHIND";
  output: string | null;
  formatOptions: unknown;
  createdAt: Date;
  updatedAt: Date;
}> = [];

let nextId = 1;

function findRow(entityId: string, target: string) {
  return emissionRows.find((r) => r.entityId === entityId && r.target === target) ?? null;
}

vi.mock("@/lib/db", () => ({
  prisma: {
    emissionTargetStatus: {
      findUnique: vi.fn().mockImplementation(async (args: { where: { entityId_target: { entityId: string; target: string } } }) => {
        return findRow(args.where.entityId_target.entityId, args.where.entityId_target.target);
      }),
      findMany: vi.fn().mockImplementation(async (args: { where: { entityId: string; target?: { in: string[] }; status?: string; stagedVersion?: { not: null } } }) => {
        let rows = emissionRows.filter((r) => r.entityId === args.where.entityId);
        if (args.where.target?.in) {
          rows = rows.filter((r) => args.where.target!.in.includes(r.target));
        }
        if (args.where.status) {
          rows = rows.filter((r) => r.status === args.where.status);
        }
        if (args.where.stagedVersion) {
          rows = rows.filter((r) => r.stagedVersion !== null);
        }
        return rows;
      }),
      upsert: vi.fn().mockImplementation(async (args: {
        where: { entityId_target: { entityId: string; target: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { entityId, target } = args.where.entityId_target;
        const existingIndex = emissionRows.findIndex((r) => r.entityId === entityId && r.target === target);
        if (existingIndex >= 0) {
          emissionRows[existingIndex] = {
            ...emissionRows[existingIndex],
            ...(args.update as Record<string, unknown>),
            updatedAt: new Date(),
          } as typeof emissionRows[0];
          return emissionRows[existingIndex];
        }
        const row = {
          id: `ets-${nextId++}`,
          ...(args.create as Record<string, unknown>),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as typeof emissionRows[0];
        emissionRows.push(row);
        return row;
      }),
      update: vi.fn().mockImplementation(async (args: {
        where: { entityId_target: { entityId: string; target: string } };
        data: Record<string, unknown>;
      }) => {
        const { entityId, target } = args.where.entityId_target;
        const index = emissionRows.findIndex((r) => r.entityId === entityId && r.target === target);
        if (index === -1) throw new Error("Not found");
        emissionRows[index] = {
          ...emissionRows[index],
          ...(args.data as Record<string, unknown>),
          updatedAt: new Date(),
        } as typeof emissionRows[0];
        return emissionRows[index];
      }),
    },
  },
}));

import {
  emitToTargets,
  stageForLater,
  emitStagedTarget,
  getStagedTargets,
  getTargetStatuses,
  getEmittedOutput,
  _resetStagedEmissionStore,
} from "@/services/staged-emission.service";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockEmitFn(target: string) {
  return ok(`Emitted output for ${target}`);
}

function failingEmitFn(target: string) {
  return err({
    code: "EMIT_ERROR",
    message: `Failed to emit for ${target}`,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Staged Emission Service", () => {
  beforeEach(() => {
    emissionRows = [];
    nextId = 1;
    vi.clearAllMocks();
    _resetStagedEmissionStore();
  });

  describe("emitToTargets", () => {
    it("partial emission only writes to selected targets", async () => {
      const result = await emitToTargets("ent-1", 3, ["bigquery", "openapi"], mockEmitFn);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data).toHaveLength(2);
      expect(result.data[0].target).toBe("bigquery");
      expect(result.data[0].success).toBe(true);
      expect(result.data[1].target).toBe("openapi");
      expect(result.data[1].success).toBe(true);

      // Verify BigQuery has output
      const bqOutput = await getEmittedOutput("ent-1", "bigquery");
      expect(bqOutput.success).toBe(true);
      if (bqOutput.success) {
        expect(bqOutput.data).not.toBeNull();
        expect(bqOutput.data!.version).toBe(3);
      }

      // Verify Avro was NOT emitted
      const avroOutput = await getEmittedOutput("ent-1", "avro");
      expect(avroOutput.success).toBe(true);
      if (avroOutput.success) {
        expect(avroOutput.data).toBeNull();
      }
    });

    it("unselected targets retain previous emitted output", async () => {
      // First emission: emit to all targets at v2
      await emitToTargets("ent-1", 2, ["bigquery", "avro", "openapi"], mockEmitFn);

      // Second emission: only emit to bigquery at v3
      await emitToTargets("ent-1", 3, ["bigquery"], (target) =>
        ok(`v3 output for ${target}`)
      );

      // BigQuery updated to v3
      const bqOutput = await getEmittedOutput("ent-1", "bigquery");
      expect(bqOutput.success).toBe(true);
      if (bqOutput.success) {
        expect(bqOutput.data!.version).toBe(3);
      }

      // Avro still at v2
      const avroOutput = await getEmittedOutput("ent-1", "avro");
      expect(avroOutput.success).toBe(true);
      if (avroOutput.success) {
        expect(avroOutput.data!.version).toBe(2);
      }
    });

    it("handles emission failure for one target gracefully", async () => {
      const result = await emitToTargets("ent-1", 3, ["bigquery", "avro"], (target) => {
        if (target === "avro") return failingEmitFn(target);
        return mockEmitFn(target);
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data[0].success).toBe(true);
      expect(result.data[1].success).toBe(false);
      expect(result.data[1].error).toContain("Failed");
    });
  });

  describe("stageForLater", () => {
    it("stores version snapshot reference correctly", async () => {
      const result = await stageForLater("ent-1", "avro", 3, false, "complex");

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.stagedVersionId).toBe(3);
      expect(result.data.targetName).toBe("avro");
      expect(result.data.compatible).toBe(false);
      expect(result.data.migrationComplexity).toBe("complex");
    });

    it("staged target shows in getStagedTargets", async () => {
      await stageForLater("ent-1", "avro", 3, false, "complex");

      const result = await getStagedTargets("ent-1");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data).toHaveLength(1);
      expect(result.data[0].targetName).toBe("avro");
    });
  });

  describe("emitStagedTarget", () => {
    it("uses correct version snapshot, not current state", async () => {
      // Stage avro at v3
      await stageForLater("ent-1", "avro", 3, false, "complex");

      // Emit the staged target — emitFn receives the staged version
      let receivedVersion: number | undefined;
      const result = await emitStagedTarget("ent-1", "avro", (target, versionId) => {
        receivedVersion = versionId;
        return ok(`Staged output for ${target} at v${versionId}`);
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(receivedVersion).toBe(3);
      expect(result.data.version).toBe(3);
    });

    it("clears staged marker after emission", async () => {
      await stageForLater("ent-1", "avro", 3, false, "complex");

      await emitStagedTarget("ent-1", "avro", (target, versionId) =>
        ok(`Output for ${target} at v${versionId}`)
      );

      const staged = await getStagedTargets("ent-1");
      expect(staged.success).toBe(true);
      if (staged.success) {
        expect(staged.data).toHaveLength(0);
      }
    });

    it("returns error when no staged target exists", async () => {
      const result = await emitStagedTarget("ent-1", "avro", mockEmitFn as unknown as (t: string, v: number) => Result<string>);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getTargetStatuses", () => {
    it("shows correct per-target status", async () => {
      // Emit BQ and OpenAPI at v3
      await emitToTargets("ent-1", 3, ["bigquery", "openapi"], mockEmitFn);

      // Stage Avro for later
      await stageForLater("ent-1", "avro", 3, false, "complex");

      const result = await getTargetStatuses("ent-1", [
        "bigquery",
        "avro",
        "openapi",
      ]);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const bq = result.data.find((s) => s.target === "bigquery");
      const avro = result.data.find((s) => s.target === "avro");
      const oapi = result.data.find((s) => s.target === "openapi");

      expect(bq!.status).toBe("current");
      expect(bq!.emittedVersion).toBe(3);

      expect(avro!.status).toBe("staged");
      expect(avro!.stagedVersion).toBe(3);

      expect(oapi!.status).toBe("current");
      expect(oapi!.emittedVersion).toBe(3);
    });

    it("returns 'behind' for targets with no emission", async () => {
      const result = await getTargetStatuses("ent-new", ["bigquery"]);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data[0].status).toBe("behind");
      expect(result.data[0].emittedVersion).toBeNull();
    });
  });

  describe("emitting all staged targets clears markers", () => {
    it("emitting all staged targets clears all staged markers", async () => {
      await stageForLater("ent-1", "avro", 3, false, "complex");
      await stageForLater("ent-1", "openapi", 3, false, "moderate");

      // Emit both staged targets
      await emitStagedTarget("ent-1", "avro", (t, v) => ok(`${t}-${v}`));
      await emitStagedTarget("ent-1", "openapi", (t, v) => ok(`${t}-${v}`));

      const staged = await getStagedTargets("ent-1");
      expect(staged.success).toBe(true);
      if (staged.success) {
        expect(staged.data).toHaveLength(0);
      }
    });
  });
});
