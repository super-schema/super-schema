import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory stores for the Prisma mock
// ---------------------------------------------------------------------------
let requests: Array<{
  id: string;
  entityId: string;
  entityName: string;
  domainId: string | null;
  versionId: string | null;
  changeType: string;
  severity: string;
  status: string;
  impactReport: unknown;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}> = [];
let approvals: Array<{
  id: string;
  requestId: string;
  approverId: string;
  decision: string;
  comment: string | null;
  decidedAt: Date;
}> = [];
let reqCounter = 0;
let aprCounter = 0;
// The entities the requests are about, and the tenant each belongs to (a request has no foreign key to its entity).
let entities: Array<{ id: string; tenantId: string }> = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    governanceRequest: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `gov-req-${++reqCounter}`,
          entityId: args.data.entityId as string,
          entityName: args.data.entityName as string,
          domainId: (args.data.domainId as string | null) ?? null,
          versionId: (args.data.versionId as string | null) ?? null,
          changeType: args.data.changeType as string,
          severity: (args.data.severity as string) ?? "low",
          status: args.data.status as string,
          impactReport: args.data.impactReport ?? null,
          requestedBy: args.data.requestedBy as string,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        requests.push(row);
        return row;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return requests.find((r) => r.id === args.where.id) ?? null;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; orderBy?: Record<string, string> }) => {
        let result = [...requests];
        if (args?.where) {
          if (args.where.entityId) {
            result = result.filter((r) => r.entityId === args.where!.entityId);
          }
          if (args.where.versionId) {
            result = result.filter((r) => r.versionId === args.where!.versionId);
          }
          if (args.where.status) {
            result = result.filter((r) => r.status === args.where!.status);
          }
          if (args.where.domainId) {
            result = result.filter((r) => r.domainId === args.where!.domainId);
          }
        }
        if (args?.orderBy?.createdAt === "desc") {
          result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return result;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = requests.find((r) => r.id === args.where.id);
        if (r) {
          Object.assign(r, args.data, { updatedAt: new Date() });
        }
        return r;
      }),
      deleteMany: vi.fn(async () => {
        requests = [];
        reqCounter = 0;
      }),
    },
    entity: {
      findFirst: vi.fn(async (args: { where: { id: string; tenantId: string } }) =>
        entities.find((e) => e.id === args.where.id && e.tenantId === args.where.tenantId) ?? null),
      findMany: vi.fn(async (args: { where: { tenantId: string; id: { in: string[] } } }) =>
        entities.filter((e) => e.tenantId === args.where.tenantId && args.where.id.in.includes(e.id)).map((e) => ({ id: e.id }))),
    },
    governanceApproval: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `gov-apr-${++aprCounter}`,
          requestId: args.data.requestId as string,
          approverId: args.data.approverId as string,
          decision: args.data.decision as string,
          comment: (args.data.comment as string | null) ?? null,
          decidedAt: new Date(),
        };
        approvals.push(row);
        return row;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        let result = [...approvals];
        if (args?.where?.requestId) {
          result = result.filter((a) => a.requestId === args.where!.requestId);
        }
        return result;
      }),
      deleteMany: vi.fn(async () => {
        approvals = [];
        aprCounter = 0;
      }),
    },
  },
}));

import {
  createRequest,
  approveRequest,
  rejectRequest,
  getRequestsForEntity,
  getPendingRequests,
  getAllRequests,
  getRequest,
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
  beforeEach(async () => {
    await _resetGovernanceStore();
  });

  describe("tenant scope", () => {
    const home = { id: "ent-home", tenantId: "tenant-a" };
    const away = { id: "ent-away", tenantId: "tenant-b" };

    async function twoRequests() {
      entities = [home, away];
      const mine = await createRequest(home.id, 2, makeClassification("breaking"), null, stewardCtx, "Home");
      const theirs = await createRequest(away.id, 2, makeClassification("breaking"), null, stewardCtx, "Away");
      if (!mine.success || !theirs.success) throw new Error("setup");
      return { mine: mine.data, theirs: theirs.data };
    }

    beforeEach(() => {
      entities = [];
    });

    it("the dashboard list holds only the requests of entities of the tenant being viewed", async () => {
      const { mine } = await twoRequests();

      const result = await getAllRequests("tenant-a");

      expect(result.success && result.data.map((r) => r.id)).toEqual([mine.id]);
    });

    it("without a tenant (a caller that is not a page) the list is everything, as it was", async () => {
      await twoRequests();
      const result = await getAllRequests();
      expect(result.success && result.data).toHaveLength(2);
    });

    it("a request of an entity that no longer exists is not listed to a tenant", async () => {
      await twoRequests();
      entities = [];
      const result = await getAllRequests("tenant-a");
      expect(result.success && result.data).toEqual([]);
    });

    it("a request of another tenant reads exactly like a missing one, by id", async () => {
      const { mine, theirs } = await twoRequests();

      expect((await getRequest(mine.id, "tenant-a")).success).toBe(true);
      const foreign = await getRequest(theirs.id, "tenant-a");
      const missing = await getRequest("gov-req-none", "tenant-a");
      expect(foreign.success).toBe(false);
      expect(!foreign.success && foreign.error.code).toBe("NOT_FOUND");
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    });

    it("approve and reject of another tenant's request answer NOT_FOUND and decide nothing", async () => {
      const { theirs } = await twoRequests();
      const inA = { ...stewardCtx, tenantId: "tenant-a" };

      const approved = await approveRequest(theirs.id, "ok", inA);
      const rejected = await rejectRequest(theirs.id, "no", inA);

      for (const result of [approved, rejected]) {
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
      }
      const stored = await getRequest(theirs.id);
      expect(stored.success && stored.data.status).toBe("PENDING");
      expect(approvals).toEqual([]);
    });

    it("approve and reject of the tenant's own request work, and the role gate is unchanged (an author is refused in any tenant)", async () => {
      const { mine } = await twoRequests();

      const refused = await approveRequest(mine.id, null, { ...authorCtx, tenantId: "tenant-a" });
      expect(!refused.success && refused.error.code).toBe("FORBIDDEN");

      const approved = await approveRequest(mine.id, "fine", { ...stewardCtx, tenantId: "tenant-a" });
      expect(approved.success).toBe(true);
      const stored = await getRequest(mine.id, "tenant-a");
      expect(stored.success && stored.data.status).toBe("APPROVED");
    });
  });

  describe("createRequest", () => {
    it("auto-approves non-breaking changes", async () => {
      const result = await createRequest(
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

    it("creates PENDING request for breaking changes", async () => {
      const result = await createRequest(
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

    it("creates PENDING request for classification changes", async () => {
      const result = await createRequest(
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
    it("changes status to APPROVED", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const result = await approveRequest(
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

    it("approval enables emission", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      // Before approval — blocked
      let gate = await checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
      }

      // Approve
      await approveRequest(createResult.data.id, null, stewardCtx);

      // After approval — allowed
      gate = await checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });
  });

  describe("rejectRequest", () => {
    it("changes status to REJECTED", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = await rejectRequest(
        createResult.data.id,
        "Too risky",
        stewardCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe("REJECTED");
      }
    });

    it("rejection blocks emission", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      await rejectRequest(createResult.data.id, "Too risky", stewardCtx);

      const gate = await checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
        expect(gate.data.reason).toContain("rejected");
      }
    });
  });

  describe("RBAC enforcement", () => {
    it("only Steward/Admin can approve", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = await approveRequest(createResult.data.id, null, authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("only Steward/Admin can reject", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = await rejectRequest(createResult.data.id, "nope", authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("Admin can approve", async () => {
      const createResult = await createRequest(
        "ent-1",
        2,
        makeClassification("breaking"),
        null,
        authorCtx
      );
      if (!createResult.success) return;

      const result = await approveRequest(createResult.data.id, null, adminCtx);
      expect(result.success).toBe(true);
    });
  });

  describe("Query functions", () => {
    it("getRequestsForEntity returns requests for the entity", async () => {
      await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      await createRequest("ent-2", 1, makeClassification("non-breaking"), null, authorCtx);

      const result = await getRequestsForEntity("ent-1");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].entityId).toBe("ent-1");
      }
    });

    it("getPendingRequests returns only pending requests", async () => {
      await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      await createRequest("ent-2", 1, makeClassification("non-breaking"), null, authorCtx);

      const result = await getPendingRequests();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].status).toBe("PENDING");
      }
    });
  });

  describe("Emission Gate", () => {
    it("allows emission when no governance request exists", async () => {
      const gate = await checkEmissionGate("ent-new", 1);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });

    it("allows emission for auto-approved changes", async () => {
      await createRequest("ent-1", 2, makeClassification("non-breaking"), null, authorCtx);

      const gate = await checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(true);
      }
    });

    it("blocks emission for pending changes", async () => {
      await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);

      const gate = await checkEmissionGate("ent-1", 2);
      expect(gate.success).toBe(true);
      if (gate.success) {
        expect(gate.data.allowed).toBe(false);
      }
    });
  });
});
