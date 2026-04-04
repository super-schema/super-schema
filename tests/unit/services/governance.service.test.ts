import { describe, it, expect, beforeEach } from "vitest";

import {
  createRequest,
  approveRequest,
  rejectRequest,
  getRequestsForEntity,
  getPendingRequests,
  checkEmissionGate,
  _resetGovernanceStore,
  type GovernanceContext,
} from "@/services/governance.service";
import type { ChangeClassification } from "@/types/schemas/classification";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stewardCtx: GovernanceContext = {
  userId: "steward-1",
  userRole: "STEWARD",
  domainId: "dom-1",
};

const adminCtx: GovernanceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  domainId: "dom-1",
};

const authorCtx: GovernanceContext = {
  userId: "author-1",
  userRole: "AUTHOR",
  domainId: "dom-1",
};

function makeClassification(
  changeType: ChangeClassification["changeType"] = "non-breaking"
): ChangeClassification {
  return {
    changeType,
    severity: changeType === "breaking" ? "high" : "low",
    reasons: [`Test reason for ${changeType}`],
    perTarget: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Governance Service", () => {
  beforeEach(() => {
    _resetGovernanceStore();
  });

  describe("createRequest", () => {
    it("auto-approves non-breaking changes", () => {
      const result = createRequest(
        "ent-1",
        2,
        makeClassification("non-breaking"),
        null,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("AUTO_APPROVED");
        expect(result.data.entityId).toBe("ent-1");
        expect(result.data.versionId).toBe(2);
        expect(result.data.requestedBy).toBe("author-1");
      }
    });

    it("creates PENDING request for breaking changes", () => {
      const result = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("PENDING");
      }
    });

    it("creates PENDING request for classification changes", () => {
      const result = createRequest(
        "ent-1",
        2,
        makeClassification("classification-change"),
        null,
        authorCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("PENDING");
      }
    });
  });

  describe("approveRequest", () => {
    it("changes status to APPROVED", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const result = approveRequest(
        createResult.data.id,
        "Looks good",
        stewardCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe("APPROVED");
        expect(result.data.comment).toBe("Looks good");
      }
    });

    it("approval enables emission", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      // Before approval — blocked
      let gate = checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
      }

      // Approve
      approveRequest(createResult.data.id, null, stewardCtx);

      // After approval — allowed
      gate = checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });
  });

  describe("rejectRequest", () => {
    it("changes status to REJECTED", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = rejectRequest(
        createResult.data.id,
        "Too risky",
        stewardCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe("REJECTED");
      }
    });

    it("rejection blocks emission", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      rejectRequest(createResult.data.id, "Too risky", stewardCtx);

      const gate = checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
        expect(gate.data.reason).toContain("rejected");
      }
    });
  });

  describe("RBAC enforcement", () => {
    it("only Steward/Admin can approve", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = approveRequest(createResult.data.id, null, authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("only Steward/Admin can reject", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = rejectRequest(createResult.data.id, "nope", authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("Admin can approve", () => {
      const createResult = createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = approveRequest(createResult.data.id, null, adminCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("Query functions", () => {
    it("getRequestsForEntity returns requests for the entity", () => {
      createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      createRequest("ent-2", 1, makeClassification("non-breaking"), null, authorCtx);

      const result = getRequestsForEntity("ent-1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].entityId).toBe("ent-1");
      }
    });

    it("getPendingRequests returns only pending requests", () => {
      createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      createRequest("ent-2", 1, makeClassification("non-breaking"), null, authorCtx);

      const result = getPendingRequests();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe("PENDING");
      }
    });
  });

  describe("Emission Gate", () => {
    it("allows emission when no governance request exists", () => {
      const gate = checkEmissionGate("ent-new", 1);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });

    it("allows emission for auto-approved changes", () => {
      createRequest("ent-1", 2, makeClassification("non-breaking"), null, authorCtx);

      const gate = checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });

    it("blocks emission for pending changes", () => {
      createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);

      const gate = checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
      }
    });
  });
});
