import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, roleRowOf } from "../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";

// ---------------------------------------------------------------------------
// In-memory stores behind the Prisma mocks
// ---------------------------------------------------------------------------

type Place = { id: string; name: string; version: number; ownerId: string; tenantId: string; domainId: string | null; productId: string | null };
type UserRow = { id: string; name: string | null; email: string; disabledAt: Date | null; roles: ReturnType<typeof roleRowOf>[] };
type RequestRow = { id: string; entityId: string; entityName: string; versionId: string | null; requestedBy: string };

let entities: Record<string, Place> = {};
let users: Record<string, UserRow> = {};
let requests: Record<string, RequestRow> = {};
let notifications: Array<Record<string, unknown>> = [];
let endpoints: Array<Record<string, unknown>> = [];
let deliveries: Array<Record<string, unknown>> = [];
let counter = 0;

const webhookReceiver = vi.hoisted(() => ({ postWebhook: vi.fn() }));
vi.mock("@/lib/webhook-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhook-transport")>()),
  postWebhook: webhookReceiver.postWebhook,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    entity: {
      // Each caller selects a different shape: the superset is returned, and each caller reads only what it selected.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = entities[where.id];
        return row ? { ...row, slug: row.name.toLowerCase(), domain: { slug: "domain-slug" }, product: { domainId: row.domainId }, fields: [] } : null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null),
    },
    governanceRequest: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => requests[where.id] ?? null),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `notif_${++counter}`, read: false, createdAt: new Date(), body: "", entityId: null, ...data };
        notifications.push(row);
        return row;
      }),
      findMany: vi.fn(async () => [...notifications]),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => {
        notifications = [];
      }),
    },
    webhookEndpoint: {
      findMany: vi.fn(async ({ where }: { where: { events: { hasSome: string[] } } }) =>
        endpoints.filter((endpoint) => (endpoint.events as string[]).some((event) => where.events.hasSome.includes(event)))
      ),
      deleteMany: vi.fn(async () => {
        endpoints = [];
      }),
    },
    webhookDelivery: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `delivery_${++counter}`, nextRetryAt: null, deliveredAt: new Date(), error: null, attempt: 1, ...data };
        deliveries.push(row);
        return row;
      }),
      // The retry queue asks for rows with a `nextRetryAt`; the deliveries of these tests all succeed, so it has none.
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => (args?.where && "nextRetryAt" in args.where ? [] : [...deliveries])),
      update: vi.fn(async () => null),
      deleteMany: vi.fn(async () => {
        deliveries = [];
      }),
    },
  },
}));

import {
  notifyAnnotationTag,
  notifyEmissionComplete,
  notifyEntityEmitted,
  notifyGovernanceApprovalRequest,
  notifyGovernanceDecision,
  notifyGovernanceRequestDecided,
} from "@/services/notification.triggers";
import { _resetStore, _getStore } from "@/services/notification.service";
import { _resetStore as _resetWebhookStore, _getDeliveries } from "@/services/webhook.service";
import type { ServiceContext } from "@/types/service-context";

const T1 = "tenant-1";
const T2 = "tenant-2";

const mockCtx: ServiceContext = {
  userId: "user-trigger",
  userRole: "AUTHOR",
  prisma: {} as ServiceContext["prisma"],
};

/** A user row as the principal loader and the trigger read it: the roles stored for `assignments`. */
function userWith(id: string, assignments: Assignment[], extra: Partial<Pick<UserRow, "name" | "disabledAt">> = {}): UserRow {
  return { id, name: null, email: `${id}@example.test`, disabledAt: null, ...extra, roles: assignments.map(roleRowOf) };
}

/** The entities of these tests: `entity-1` (UserProfile v2) and `entity-3` (PaymentEvent v3) of tenant 1, domain dom-a, product prod-a; owner-1 owns both. */
function seedEntities() {
  const place = (id: string, name: string, version: number): Place => ({ id, name, version, ownerId: "owner-1", tenantId: T1, domainId: "dom-a", productId: "prod-a" });
  entities = {
    "entity-1": place("entity-1", "UserProfile", 2),
    "entity-2": place("entity-2", "OrderEntity", 1),
    "entity-3": place("entity-3", "PaymentEvent", 3),
  };
}

/** Owners and people with each kind of role over the entities above, one who is disabled, and one of another tenant. */
function seedUsers() {
  users = {
    "owner-1": userWith("owner-1", [assign.domain("AUTHOR", T1, "dom-a")], { name: "Olga Owner" }),
    "steward-1": userWith("steward-1", [assign.domain("STEWARD", T1, "dom-a")], { name: "Jane Steward" }),
    "viewer-1": userWith("viewer-1", [assign.domain("VIEWER", T1, "dom-a")]),
    "requestor-1": userWith("requestor-1", [assign.domain("AUTHOR", T1, "dom-a")]),
    "outsider-1": userWith("outsider-1", [assign.tenant("ADMIN", T2)]),
    "former-1": userWith("former-1", []),
    "disabled-1": userWith("disabled-1", [assign.domain("ADMIN", T1, "dom-a")], { disabledAt: new Date() }),
  };
}

function seedRequests() {
  requests = {
    "req-1": { id: "req-1", entityId: "entity-1", entityName: "UserProfile", versionId: "2", requestedBy: "requestor-1" },
  };
}

function endpoint(id: string, events: string[]) {
  return { id, url: `https://hooks.example.test/${id}`, events, secret: "s".repeat(64), active: true, createdBy: null, createdAt: new Date(), updatedAt: new Date() };
}

/** The webhook receiver: every delivery answers 200. */
const fetchMock = webhookReceiver.postWebhook;
let consoleSpy: { mockRestore: () => void } | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  seedEntities();
  seedUsers();
  seedRequests();
  await _resetStore();
  await _resetWebhookStore();
  endpoints = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleSpy?.mockRestore();
});

describe("Notification Triggers", () => {
  describe("notifyGovernanceApprovalRequest", () => {
    it("tells the stewards who may decide the entity, and no one else", async () => {
      await notifyGovernanceApprovalRequest("entity-1", "UserProfile", "2", "dom-a", ["steward-1", "viewer-1", "outsider-1", "former-1"], mockCtx);

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("APPROVAL_REQUEST");
      expect(store[0].userId).toBe("steward-1");
      expect(store[0].title).toContain("UserProfile");
      expect(store[0].title).toContain("v2");
    });

    it("dispatches governance.request.created, with the tenant of the entity", async () => {
      endpoints = [endpoint("e1", ["governance.request.created"])];

      await notifyGovernanceApprovalRequest("entity-1", "UserProfile", "2", "dom-a", ["steward-1"], mockCtx);

      const [delivery] = await _getDeliveries();
      expect(delivery.event).toBe("governance.request.created");
      expect(delivery.payload).toMatchObject({ event: "governance.request.created", data: { tenantId: T1, entityId: "entity-1", entityName: "UserProfile", version: "2" } });
    });
  });

  describe("notifyGovernanceDecision", () => {
    it("creates APPROVAL_DECISION for requestor — approved", async () => {
      await notifyGovernanceDecision("requestor-1", "UserProfile", "approved", "Jane Steward", { entityId: "entity-1" }, mockCtx);

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("APPROVAL_DECISION");
      expect(store[0].userId).toBe("requestor-1");
      expect(store[0].title).toContain("approved");
      expect(store[0].title).toContain("Jane Steward");
    });

    it("creates APPROVAL_DECISION for requestor — rejected, and dispatches governance.request.rejected", async () => {
      endpoints = [endpoint("e1", ["governance.request.rejected"]), endpoint("e2", ["governance.request.approved"])];

      await notifyGovernanceDecision("requestor-1", "UserProfile", "rejected", "John Admin", { entityId: "entity-1" }, mockCtx);

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].title).toContain("rejected");
      expect(store[0].title).toContain("John Admin");
      expect(deliveries.map((row) => row.event)).toEqual(["governance.request.rejected"]);
    });

    it("tells a requestor who no longer holds a role on the entity nothing, and still dispatches the event", async () => {
      endpoints = [endpoint("e1", ["governance.request.approved"])];

      await notifyGovernanceDecision("former-1", "UserProfile", "approved", "Jane Steward", { entityId: "entity-1" }, mockCtx);

      expect(await _getStore()).toHaveLength(0);
      expect(deliveries.map((row) => row.event)).toEqual(["governance.request.approved"]);
    });
  });

  describe("notifyAnnotationTag", () => {
    it("creates ANNOTATION_TAG for each tagged user who can read the entity", async () => {
      users["tagged-1"] = userWith("tagged-1", [assign.domain("VIEWER", T1, "dom-a")]);

      await notifyAnnotationTag(["tagged-1", "outsider-1"], "Alice", "OrderEntity", "status", { entityId: "entity-2", fieldId: "field-1" }, mockCtx);

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("ANNOTATION_TAG");
      expect(store[0].userId).toBe("tagged-1");
      expect(store[0].title).toContain("Alice");
      expect(store[0].title).toContain("OrderEntity.status");
      expect((store[0].entityRef as { fieldId?: string }).fieldId).toBe("field-1");
    });
  });

  describe("notifyEmissionComplete", () => {
    it("creates CHANGE_COMPLETE for the entity owner and dispatches emission.completed with the tenant", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];

      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 5, { entityId: "entity-3", versionId: "3" }, mockCtx, "stored");

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].type).toBe("CHANGE_COMPLETE");
      expect(store[0].userId).toBe("owner-1");
      expect(store[0].title).toContain("PaymentEvent");
      expect(store[0].title).toContain("v3");
      expect(store[0].title).toContain("5 targets");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].payload).toMatchObject({ event: "emission.completed", data: { tenantId: T1, entityId: "entity-3", targetCount: 5 } });
    });

    it("says `1 target` for a single target", async () => {
      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 1, { entityId: "entity-3", versionId: "3" }, mockCtx, "stored");

      expect((await _getStore())[0].title).toBe("PaymentEvent v3 emitted to 1 target");
    });

    it("tells an owner who lost the entity's tenant nothing, and the endpoints still hear of the emission", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];

      await notifyEmissionComplete("outsider-1", "PaymentEvent", "3", 5, { entityId: "entity-3", versionId: "3" }, mockCtx, "stored");

      expect(await _getStore()).toHaveLength(0);
      expect(deliveries).toHaveLength(1);
    });

    it("notifies nobody and dispatches nothing for an entity that does not exist", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];

      await notifyEmissionComplete("owner-1", "Gone", "1", 5, { entityId: "entity-gone" }, mockCtx, "stored");

      expect(await _getStore()).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deliveries).toHaveLength(0);
    });

    it("says in the payload whether the run stored a version or only previewed one", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];

      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 2, { entityId: "entity-3" }, mockCtx, "preview");

      expect(deliveries[0].payload).toMatchObject({ event: "emission.completed", data: { run: "preview", targetCount: 2 } });
    });

    it("does not tell the owner of an emission they made themselves; the endpoints still hear of it", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];

      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 5, { entityId: "entity-3" }, { ...mockCtx, userId: "owner-1" }, "stored");

      expect(await _getStore()).toHaveLength(0);
      expect(deliveries).toHaveLength(1);
    });
  });

  describe("notifyEntityEmitted (what the write paths call: the id, and the trigger reads the rest)", () => {
    it("reads the owner, the name and the version of the entity", async () => {
      await notifyEntityEmitted("entity-3", 4, mockCtx, "preview");

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].userId).toBe("owner-1");
      expect(store[0].title).toBe("PaymentEvent v3 emitted to 4 targets");
      expect(store[0].entityRef).toMatchObject({ entityId: "entity-3", versionId: "3" });
    });

    it("does nothing for an entity that does not exist", async () => {
      await notifyEntityEmitted("entity-gone", 4, mockCtx, "preview");

      expect(await _getStore()).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });
  });

  describe("notifyGovernanceRequestDecided (what the decision actions call)", () => {
    it("tells the requestor who decided, by name, and dispatches the event", async () => {
      endpoints = [endpoint("e1", ["governance.request.approved"])];

      await notifyGovernanceRequestDecided("req-1", "approved", "steward-1", mockCtx);

      const store = await _getStore();
      expect(store).toHaveLength(1);
      expect(store[0].userId).toBe("requestor-1");
      expect(store[0].title).toBe("Your change to UserProfile was approved by Jane Steward");
      expect(deliveries[0].payload).toMatchObject({ event: "governance.request.approved", data: { tenantId: T1, entityId: "entity-1", decision: "approved" } });
    });

    it("never names the decider by an e-mail address: a decider with no name is `a steward`, and the endpoints get no address", async () => {
      endpoints = [endpoint("e1", ["governance.request.approved"])];
      users["nameless-1"] = userWith("nameless-1", [assign.domain("STEWARD", T1, "dom-a")]);

      await notifyGovernanceRequestDecided("req-1", "approved", "nameless-1", mockCtx);

      expect((await _getStore())[0].title).toBe("Your change to UserProfile was approved by a steward");
      expect(JSON.stringify(deliveries[0].payload)).not.toContain("@");
    });

    it("names the API key when the decision was made with one (a service principal is no user row)", async () => {
      await notifyGovernanceRequestDecided("req-1", "rejected", "api-key-user", mockCtx);

      expect((await _getStore())[0].title).toBe("Your change to UserProfile was rejected by the API key");
    });

    it("does nothing for a request that does not exist", async () => {
      await notifyGovernanceRequestDecided("req-gone", "approved", "steward-1", mockCtx);

      expect(await _getStore()).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });
  });

  describe("failures never escape a trigger", () => {
    it("a database failure is logged and throws nothing", async () => {
      const { prisma } = await import("@/lib/db");
      vi.mocked(prisma.entity.findUnique).mockRejectedValueOnce(new Error("DB connection failed"));

      await expect(notifyEmissionComplete("owner-1", "PaymentEvent", "3", 5, { entityId: "entity-3" }, mockCtx, "stored")).resolves.toBeUndefined();
      expect(console.error).toHaveBeenCalled();
    });

    it("a notification that cannot be created does not stop the webhook event", async () => {
      endpoints = [endpoint("e1", ["emission.completed"])];
      const { prisma } = await import("@/lib/db");
      vi.mocked(prisma.notification.create).mockRejectedValueOnce(new Error("Simulated failure"));

      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 5, { entityId: "entity-3" }, mockCtx, "stored");

      expect(console.error).toHaveBeenCalled();
      expect(deliveries).toHaveLength(1);
    });

    it("a notification the service refuses (a title over its limit) is logged and nothing is stored", async () => {
      await notifyEmissionComplete("owner-1", "X".repeat(300), "3", 5, { entityId: "entity-3" }, mockCtx, "stored");

      expect(await _getStore()).toHaveLength(0);
      expect(console.error).toHaveBeenCalled();
    });

    it("a failed webhook dispatch does not stop the in-app notification", async () => {
      const { prisma } = await import("@/lib/db");
      vi.mocked(prisma.webhookEndpoint.findMany).mockRejectedValueOnce(new Error("DB connection failed"));

      await notifyEmissionComplete("owner-1", "PaymentEvent", "3", 5, { entityId: "entity-3" }, mockCtx, "stored");

      expect(await _getStore()).toHaveLength(1);
    });
  });
});
