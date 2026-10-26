import { describe, it, expect, beforeEach, vi } from "vitest";
import { assign } from "../../helpers/access-mocks";

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
// The entities the requests are about, and where each lives (a request has no foreign key to its entity): its tenant, and its domain and product.
let entities: Array<{ id: string; tenantId: string; domainId?: string | null; productId?: string | null }> = [];
const placeRow = (e: { tenantId: string; domainId?: string | null; productId?: string | null }) => ({ tenantId: e.tenantId, domainId: e.domainId ?? null, productId: e.productId ?? null, product: null });

vi.mock("@/lib/db", () => {
  const prisma: Record<string, unknown> = {
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
      // A COPY, like a database read: a row read before another decision landed stays as it was read (the check-then-act race).
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        const row = requests.find((r) => r.id === args.where.id);
        return row ? { ...row } : null;
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
      // Like the database: the filter and the write are ONE step (a row that is no longer PENDING is not matched).
      updateMany: vi.fn(async (args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
        const matched = requests.filter((r) => r.id === args.where.id && (args.where.status === undefined || r.status === args.where.status));
        for (const r of matched) Object.assign(r, args.data, { updatedAt: new Date() });
        return { count: matched.length };
      }),
      count: vi.fn(async (args?: { where?: { status?: string } }) => requests.filter((r) => args?.where?.status === undefined || r.status === args.where.status).length),
      deleteMany: vi.fn(async () => {
        requests = [];
        reqCounter = 0;
      }),
    },
    entity: {
      // With no tenant in the filter (a caller that is not a page) the entity is found by its id alone, like the database does.
      findFirst: vi.fn(async (args: { where: { id: string; tenantId?: string } }) => {
        const found = entities.find((e) => e.id === args.where.id && (args.where.tenantId === undefined || e.tenantId === args.where.tenantId));
        return found ? { id: found.id, ...placeRow(found) } : null;
      }),
      findMany: vi.fn(async (args: { where: { tenantId: string; id: { in: string[] } } }) =>
        entities.filter((e) => e.tenantId === args.where.tenantId && args.where.id.in.includes(e.id)).map((e) => ({ id: e.id, ...placeRow(e) }))),
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
  };
  // An interactive transaction: the callback gets the same (in-memory) client.
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  // The one counting query of `countPendingRequests(tenantId)`: the PENDING requests that have an entity of the tenant (the tagged template's only value).
  prisma.$queryRaw = vi.fn(async (_strings: TemplateStringsArray, tenantId: string) => {
    const inTenant = new Set(entities.filter((e) => e.tenantId === tenantId).map((e) => e.id));
    return [{ n: requests.filter((r) => r.status === "PENDING" && inTenant.has(r.entityId)).length }];
  });
  return { prisma };
});

import {
  createRequest,
  approveRequest,
  rejectRequest,
  getRequestsForEntity,
  getPendingRequests,
  getAllRequests,
  getRequest,
  countPendingRequests,
  checkEmissionGate,
  _resetGovernanceStore,
  type GovernanceContext,
} from "@/services/governance.service";
import type { ChangeClassification } from "@/types/schemas/classification";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The callers hold their role over tenant-a, where the entities of these tests live (the service judges `governance.decide` over the request's entity).
const stewardCtx: GovernanceContext = {
  userId: "steward-1",
  assignments: [assign.tenant("STEWARD", "tenant-a")],
  domainId: "dom-1",
};

const adminCtx: GovernanceContext = {
  userId: "admin-1",
  assignments: [assign.tenant("ADMIN", "tenant-a")],
  domainId: "dom-1",
};

const complianceOfficerCtx: GovernanceContext = {
  userId: "co-1",
  assignments: [assign.tenant("COMPLIANCE_OFFICER", "tenant-a")],
  domainId: "dom-1",
};

const authorCtx: GovernanceContext = {
  userId: "author-1",
  assignments: [assign.tenant("AUTHOR", "tenant-a")],
  domainId: "dom-1",
};

const viewerCtx: GovernanceContext = {
  userId: "viewer-1",
  assignments: [assign.tenant("VIEWER", "tenant-a")],
  domainId: "dom-1",
};

/** The entity most tests make a request about. */
const ENT_1 = { id: "ent-1", tenantId: "tenant-a", domainId: "dom-1", productId: "prod-1" };

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
    entities = [ENT_1];
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

    it("with a visibility filter, only the requests whose entity the caller may read are listed", async () => {
      entities = [
        { id: "ent-home", tenantId: "tenant-a", domainId: "dom-1", productId: "prod-1" },
        { id: "ent-sibling", tenantId: "tenant-a", domainId: "dom-2", productId: "prod-2" },
      ];
      const own = await createRequest("ent-home", 2, makeClassification("breaking"), null, stewardCtx, "Home");
      await createRequest("ent-sibling", 2, makeClassification("breaking"), null, stewardCtx, "Sibling");
      if (!own.success) throw new Error("setup");
      const result = await getAllRequests("tenant-a", (place) => place.domainId === "dom-1");
      expect(result.success && result.data.map((r) => r.id)).toEqual([own.data.id]);
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

    /** An error as a caller sees it, with the request id it was asked about taken out: all that is left is what the answer tells. */
    const shape = (result: { success: boolean; error?: unknown }, id: string) => JSON.parse(JSON.stringify(result).split(id).join("<id>"));

    it("a request of another tenant reads exactly like a missing one, by id", async () => {
      const { mine, theirs } = await twoRequests();

      expect((await getRequest(mine.id, "tenant-a")).success).toBe(true);
      const foreign = await getRequest(theirs.id, "tenant-a");
      const missing = await getRequest("gov-req-none", "tenant-a");
      expect(foreign.success).toBe(false);
      expect(!foreign.success && foreign.error.code).toBe("NOT_FOUND");
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      // The whole answer (code, message, suggested fix) is the same: it is no oracle for "this id exists in another tenant".
      expect(shape(foreign, theirs.id)).toEqual(shape(missing, "gov-req-none"));
      expect(shape(foreign, theirs.id)).toEqual({ success: false, error: expect.objectContaining({ code: "NOT_FOUND", message: 'Governance request "<id>" not found' }) });
    });

    it("approve and reject of another tenant's request give the same whole answer as for a missing one", async () => {
      const { theirs } = await twoRequests();
      const inA = { ...stewardCtx, tenantId: "tenant-a" };

      expect(shape(await approveRequest(theirs.id, "ok", inA), theirs.id)).toEqual(shape(await approveRequest("gov-req-none", "ok", inA), "gov-req-none"));
      expect(shape(await rejectRequest(theirs.id, "no", inA), theirs.id)).toEqual(shape(await rejectRequest("gov-req-none", "no", inA), "gov-req-none"));
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

    it("approve and reject of the tenant's own request work, and an author is refused (a generic refusal)", async () => {
      const { mine } = await twoRequests();

      const refused = await approveRequest(mine.id, null, { ...authorCtx, tenantId: "tenant-a" });
      expect(!refused.success && refused.error.code).toBe("FORBIDDEN");
      expect(!refused.success && refused.error.message).toBe("You do not have permission to do this");

      const approved = await approveRequest(mine.id, "fine", { ...stewardCtx, tenantId: "tenant-a" });
      expect(approved.success).toBe(true);
      const stored = await getRequest(mine.id, "tenant-a");
      expect(stored.success && stored.data.status).toBe("APPROVED");
    });
  });

  // FINAL WAVE 2b, G9: a decision is ONE atomic step: two stewards deciding at once cannot both win.
  describe("two decisions at once", () => {
    beforeEach(() => {
      entities = [ENT_1];
    });

    it("exactly one of two simultaneous decisions is recorded; the other is told the request was already decided", async () => {
      const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, stewardCtx, "Order");
      if (!created.success) throw new Error("setup");

      const [approved, rejected] = await Promise.all([
        approveRequest(created.data.id, "ok", stewardCtx),
        rejectRequest(created.data.id, "no", { ...stewardCtx, userId: "steward-2" }),
      ]);

      expect([approved.success, rejected.success].filter(Boolean)).toHaveLength(1);
      const loser = approved.success ? rejected : approved;
      expect(!loser.success && loser.error.code).toBe("INVALID_STATE");
      expect(!loser.success && loser.error.message).toMatch(/already|status/);
      // one approval row, and it is the winner's; the request's status is the winner's decision
      expect(approvals).toHaveLength(1);
      const winner = approved.success ? approved : rejected;
      expect(approvals[0].id).toBe(winner.success ? winner.data.id : "");
      const stored = await getRequest(created.data.id);
      expect(stored.success && stored.data.status).toBe(approved.success ? "APPROVED" : "REJECTED");
    });

    it("many simultaneous approvals record exactly one", async () => {
      const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, stewardCtx, "Order");
      if (!created.success) throw new Error("setup");
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => approveRequest(created.data.id, null, { ...stewardCtx, userId: "steward-" + i })));
      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(approvals).toHaveLength(1);
    });

    it("both writes of a decision go through ONE transaction", async () => {
      const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, stewardCtx, "Order");
      if (!created.success) throw new Error("setup");
      const { prisma } = await import("@/lib/db");
      vi.mocked(prisma.$transaction).mockClear();
      await approveRequest(created.data.id, null, stewardCtx);
      expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
    });
  });

  // The Admin > Health "Pending Governance" count follows the same rule as the dashboard list.
  describe("countPendingRequests", () => {
    it("counts the PENDING requests of entities of the tenant (a deleted entity's and another tenant's do not count), like the list does", async () => {
      entities = [{ id: "ent-a", tenantId: "tenant-a" }, { id: "ent-b", tenantId: "tenant-b" }];
      await createRequest("ent-a", 1, makeClassification("breaking"), null, stewardCtx, "A");
      await createRequest("ent-a", 2, makeClassification("breaking"), null, stewardCtx, "A");
      await createRequest("ent-b", 1, makeClassification("breaking"), null, stewardCtx, "B");
      await createRequest("ent-gone", 1, makeClassification("breaking"), null, stewardCtx, "Gone");
      await createRequest("ent-a", 3, makeClassification("non-breaking"), null, stewardCtx, "A"); // AUTO_APPROVED

      expect(await countPendingRequests("tenant-a")).toBe(2);
      expect(await countPendingRequests("tenant-b")).toBe(1);
      expect(await countPendingRequests("tenant-none")).toBe(0);
      // the list the dashboard shows has the same pending ones
      const listed = await getAllRequests("tenant-a");
      expect(listed.success && listed.data.filter((r) => r.status === "PENDING")).toHaveLength(2);
      // without a tenant (a caller that is not a page) it is every pending request, as the list is every request
      expect(await countPendingRequests()).toBe(4);
    });
  });

  describe("countPendingRequests is one counting query", () => {
    it("loads no request row and no entity row (it used to read every PENDING request of ALL tenants and filter them in memory)", async () => {
      entities = [{ id: "ent-a", tenantId: "tenant-a" }];
      for (let i = 0; i < 5; i += 1) await createRequest("ent-a", i + 1, makeClassification("breaking"), null, stewardCtx, "A");
      const { prisma } = await import("@/lib/db");
      const requestRows = prisma.governanceRequest.findMany as unknown as ReturnType<typeof vi.fn>;
      const entityRows = prisma.entity.findMany as unknown as ReturnType<typeof vi.fn>;
      requestRows.mockClear();
      entityRows.mockClear();
      (prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockClear();
      expect(await countPendingRequests("tenant-a")).toBe(5);
      expect(requestRows).not.toHaveBeenCalled();
      expect(entityRows).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
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

    it("a Compliance Officer can approve and reject (steward and above)", async () => {
      for (const decide of [approveRequest, rejectRequest]) {
        const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
        if (!created.success) throw new Error("setup");
        expect((await decide(created.data.id, null, complianceOfficerCtx)).success).toBe(true);
      }
    });

    it("a Viewer is refused, and so is a caller with no assignments or none over the entity: nothing is decided", async () => {
      const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      if (!created.success) throw new Error("setup");
      const viewer = await approveRequest(created.data.id, null, viewerCtx);
      expect(!viewer.success && viewer.error.code).toBe("FORBIDDEN");
      for (const assignments of [undefined, [], [assign.tenant("ADMIN", "tenant-b")], [assign.domain("ADMIN", "tenant-a", "dom-other")]]) {
        const refused = await approveRequest(created.data.id, null, { userId: "x", assignments });
        expect(!refused.success && refused.error.code, JSON.stringify(assignments)).toBe("NOT_FOUND");
      }
      expect(approvals).toEqual([]);
      const stored = await getRequest(created.data.id);
      expect(stored.success && stored.data.status).toBe("PENDING");
    });

    it("a domain-scoped steward decides the requests of ITS domain only; a product-scoped one those of its product only", async () => {
      const created = await createRequest("ent-1", 2, makeClassification("breaking"), null, authorCtx);
      if (!created.success) throw new Error("setup");
      const sibling = { userId: "s", assignments: [assign.domain("STEWARD", "tenant-a", "dom-other")] };
      expect((await approveRequest(created.data.id, null, sibling)).success).toBe(false);
      const siblingProduct = { userId: "s", assignments: [assign.product("STEWARD", "tenant-a", "dom-1", "prod-other")] };
      expect((await approveRequest(created.data.id, null, siblingProduct)).success).toBe(false);
      const own = { userId: "s", assignments: [assign.product("STEWARD", "tenant-a", "dom-1", "prod-1")] };
      expect((await approveRequest(created.data.id, null, own)).success).toBe(true);
    });

    it("a request of an entity that no longer exists is missing for everybody, a platform administrator included (it has no place)", async () => {
      const created = await createRequest("ent-gone", 2, makeClassification("breaking"), null, authorCtx);
      if (!created.success) throw new Error("setup");
      const result = await approveRequest(created.data.id, null, { userId: "a", assignments: [assign.global()] });
      expect(!result.success && result.error.code).toBe("NOT_FOUND");
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
