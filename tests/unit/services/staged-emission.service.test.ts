import { describe, it, expect, beforeEach } from "vitest";

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
    _resetStagedEmissionStore();
  });

  describe("emitToTargets", () => {
    it("partial emission only writes to selected targets", () => {
      const result = emitToTargets("ent-1", 3, ["bigquery", "openapi"], mockEmitFn);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data).toHaveLength(2);
      expect(result.data[0].target).toBe("bigquery");
      expect(result.data[0].success).toBe(true);
      expect(result.data[1].target).toBe("openapi");
      expect(result.data[1].success).toBe(true);

      // Verify BigQuery has output
      const bqOutput = getEmittedOutput("ent-1", "bigquery");
      expect(bqOutput.success).toBe(true);
      if (bqOutput.success) {
        expect(bqOutput.data).not.toBeNull();
        expect(bqOutput.data!.version).toBe(3);
      }

      // Verify Avro was NOT emitted
      const avroOutput = getEmittedOutput("ent-1", "avro");
      expect(avroOutput.success).toBe(true);
      if (avroOutput.success) {
        expect(avroOutput.data).toBeNull();
      }
    });

    it("unselected targets retain previous emitted output", () => {
      // First emission: emit to all targets at v2
      emitToTargets("ent-1", 2, ["bigquery", "avro", "openapi"], mockEmitFn);

      // Second emission: only emit to bigquery at v3
      emitToTargets("ent-1", 3, ["bigquery"], (target) =>
        ok(`v3 output for ${target}`)
      );

      // BigQuery updated to v3
      const bqOutput = getEmittedOutput("ent-1", "bigquery");
      expect(bqOutput.success).toBe(true);
      if (bqOutput.success) {
        expect(bqOutput.data!.version).toBe(3);
      }

      // Avro still at v2
      const avroOutput = getEmittedOutput("ent-1", "avro");
      expect(avroOutput.success).toBe(true);
      if (avroOutput.success) {
        expect(avroOutput.data!.version).toBe(2);
      }
    });

    it("handles emission failure for one target gracefully", () => {
      const result = emitToTargets("ent-1", 3, ["bigquery", "avro"], (target) => {
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
    it("stores version snapshot reference correctly", () => {
      const result = stageForLater("ent-1", "avro", 3, false, "complex");

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.stagedVersionId).toBe(3);
      expect(result.data.targetName).toBe("avro");
      expect(result.data.compatible).toBe(false);
      expect(result.data.migrationComplexity).toBe("complex");
    });

    it("staged target shows in getStagedTargets", () => {
      stageForLater("ent-1", "avro", 3, false, "complex");

      const result = getStagedTargets("ent-1");
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data).toHaveLength(1);
      expect(result.data[0].targetName).toBe("avro");
    });
  });

  describe("emitStagedTarget", () => {
    it("uses correct version snapshot, not current state", () => {
      // Stage avro at v3
      stageForLater("ent-1", "avro", 3, false, "complex");

      // Emit the staged target — emitFn receives the staged version
      let receivedVersion: number | undefined;
      const result = emitStagedTarget("ent-1", "avro", (target, versionId) => {
        receivedVersion = versionId;
        return ok(`Staged output for ${target} at v${versionId}`);
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Verify the emitFn received the staged version (v3), not some other version
      expect(receivedVersion).toBe(3);
      expect(result.data.version).toBe(3);
    });

    it("clears staged marker after emission", () => {
      stageForLater("ent-1", "avro", 3, false, "complex");

      emitStagedTarget("ent-1", "avro", (target, versionId) =>
        ok(`Output for ${target} at v${versionId}`)
      );

      const staged = getStagedTargets("ent-1");
      expect(staged.success).toBe(true);
      if (staged.success) {
        expect(staged.data).toHaveLength(0);
      }
    });

    it("returns error when no staged target exists", () => {
      const result = emitStagedTarget("ent-1", "avro", mockEmitFn as any);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getTargetStatuses", () => {
    it("shows correct per-target status", () => {
      // Emit BQ and OpenAPI at v3
      emitToTargets("ent-1", 3, ["bigquery", "openapi"], mockEmitFn);

      // Stage Avro for later
      stageForLater("ent-1", "avro", 3, false, "complex");

      const result = getTargetStatuses("ent-1", [
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

    it("returns 'behind' for targets with no emission", () => {
      const result = getTargetStatuses("ent-new", ["bigquery"]);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data[0].status).toBe("behind");
      expect(result.data[0].emittedVersion).toBeNull();
    });
  });

  describe("emitting all staged targets clears markers", () => {
    it("emitting all staged targets clears all staged markers", () => {
      stageForLater("ent-1", "avro", 3, false, "complex");
      stageForLater("ent-1", "openapi", 3, false, "moderate");

      // Emit both staged targets
      emitStagedTarget("ent-1", "avro", (t, v) => ok(`${t}-${v}`));
      emitStagedTarget("ent-1", "openapi", (t, v) => ok(`${t}-${v}`));

      const staged = getStagedTargets("ent-1");
      expect(staged.success).toBe(true);
      if (staged.success) {
        expect(staged.data).toHaveLength(0);
      }
    });
  });
});
