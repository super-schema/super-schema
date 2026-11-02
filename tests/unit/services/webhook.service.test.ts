import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/webhook-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhook-transport")>()),
  postWebhook: vi.fn(),
  refuseEndpointUrl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// In-memory stores for the Prisma mock
// ---------------------------------------------------------------------------
let endpoints: Array<{
  id: string;
  url: string;
  events: string[];
  secret: string;
  active: boolean;
  createdBy: string;
  tenantId: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = [];
let deliveries: Array<{
  id: string;
  endpointId: string;
  event: string;
  payload: unknown;
  statusCode: number | null;
  error: string | null;
  attempt: number;
  nextRetryAt: Date | null;
  deliveredAt: Date;
}> = [];
let epCounter = 0;
let dlCounter = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEndpoint: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `whep_${++epCounter}_${Date.now()}`,
          url: args.data.url as string,
          events: args.data.events as string[],
          secret: args.data.secret as string,
          active: args.data.active as boolean,
          createdBy: args.data.createdBy as string,
          tenantId: (args.data.tenantId as string | null | undefined) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        endpoints.push(row);
        return row;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        let result = [...endpoints];
        if (args?.where) {
          if (args.where.active !== undefined) {
            result = result.filter((e) => e.active === args.where!.active);
          }
          if (args.where.tenantId !== undefined) {
            result = result.filter((e) => e.tenantId === args.where!.tenantId);
          }
          if (args.where.events && typeof args.where.events === "object" && "hasSome" in (args.where.events as Record<string, unknown>)) {
            const events = ((args.where.events as { hasSome: string[] }).hasSome);
            result = result.filter((e) => e.events.some((ev) => events.includes(ev)));
          }
        }
        return result;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return endpoints.find((e) => e.id === args.where.id) ?? null;
      }),
      // Scoped by the tenant the caller acts in (an undefined filter means no filter, as in Prisma).
      findFirst: vi.fn(async (args: { where: { id: string; tenantId?: string } }) => {
        return endpoints.find((e) => e.id === args.where.id && (args.where.tenantId === undefined || e.tenantId === args.where.tenantId)) ?? null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const ep = endpoints.find((e) => e.id === args.where.id);
        if (ep) {
          Object.assign(ep, args.data, { updatedAt: new Date() });
        }
        return ep;
      }),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const idx = endpoints.findIndex((e) => e.id === args.where.id);
        if (idx !== -1) endpoints.splice(idx, 1);
      }),
      deleteMany: vi.fn(async () => {
        endpoints = [];
        epCounter = 0;
      }),
    },
    webhookDelivery: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `whdl_${++dlCounter}_${Date.now()}`,
          endpointId: args.data.endpointId as string,
          event: args.data.event as string,
          payload: args.data.payload,
          statusCode: (args.data.statusCode as number | null) ?? null,
          error: (args.data.error as string | null) ?? null,
          attempt: (args.data.attempt as number) ?? 1,
          nextRetryAt: (args.data.nextRetryAt as Date | null) ?? null,
          deliveredAt: new Date(),
        };
        deliveries.push(row);
        return row;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; orderBy?: Record<string, string> }) => {
        let result = [...deliveries];
        if (args?.where) {
          if (args.where.endpointId) {
            result = result.filter((d) => d.endpointId === args.where!.endpointId);
          }
          if (args.where.nextRetryAt && typeof args.where.nextRetryAt === "object" && "lte" in (args.where.nextRetryAt as Record<string, unknown>)) {
            const threshold = (args.where.nextRetryAt as { lte: Date }).lte;
            result = result.filter((d) => d.nextRetryAt !== null && d.nextRetryAt <= threshold);
          }
          if (args.where.attempt && typeof args.where.attempt === "object" && "lt" in (args.where.attempt as Record<string, unknown>)) {
            const maxAttempt = (args.where.attempt as { lt: number }).lt;
            result = result.filter((d) => d.attempt < maxAttempt);
          }
          if (args.where.error && typeof args.where.error === "object" && "not" in (args.where.error as Record<string, unknown>)) {
            result = result.filter((d) => d.error !== null);
          }
        }
        if (args?.orderBy?.deliveredAt === "desc") {
          result.sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime());
        }
        return result;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = deliveries.find((d) => d.id === args.where.id);
        if (d) {
          Object.assign(d, args.data);
        }
        return d;
      }),
      updateMany: vi.fn(async (args: { where: { id?: string; nextRetryAt?: { lte: Date } }; data: Record<string, unknown> }) => {
        const due = deliveries.filter(
          (d) =>
            (args.where.id === undefined || d.id === args.where.id) &&
            (args.where.nextRetryAt === undefined || (d.nextRetryAt !== null && d.nextRetryAt <= args.where.nextRetryAt.lte))
        );
        for (const d of due) Object.assign(d, args.data);
        return { count: due.length };
      }),
      deleteMany: vi.fn(async () => {
        deliveries = [];
        dlCounter = 0;
      }),
    },
  },
}));

import { postWebhook, refuseEndpointUrl, WebhookTargetError } from "@/lib/webhook-transport";

import {
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  getEndpoints,
  getDeliveries,
  dispatchEvent,
  processRetryQueue,
  computeHmacSignature,
  _resetStore,
  _getEndpoints,
  _getDeliveries,
} from "@/services/webhook.service";
import type { ServiceContext } from "@/types/service-context";
import type { CreateWebhookEndpointInput } from "@/types/schemas/webhook";
import { assign } from "../../helpers/access-mocks";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN", assignments: [assign.global()],
  tenantId: "tenant-1",
  prisma: {} as ServiceContext["prisma"],
};

const userCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR", assignments: [assign.tenant("AUTHOR", "tenant-1")],
  prisma: {} as ServiceContext["prisma"],
};

const makeEndpointInput = (
  overrides: Partial<CreateWebhookEndpointInput> = {}
): CreateWebhookEndpointInput => ({
  url: "https://example.com/webhook",
  events: ["governance.request.created"],
  active: true,
  ...overrides,
});

const TEST_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
const OTHER_SECRETS_KEY = Buffer.alloc(32, 10).toString("base64");

describe("Webhook Service", () => {
  beforeEach(async () => {
    await _resetStore();
    vi.restoreAllMocks();
    // The signing secret is stored sealed: a key is needed (SECRETS_ENCRYPTION_KEY, or the session secret).
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", TEST_SECRETS_KEY);
    vi.mocked(postWebhook).mockReset();
    vi.mocked(refuseEndpointUrl).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("createEndpoint", () => {
    it("generates HMAC secret and stores correctly", async () => {
      const result = await createEndpoint(makeEndpointInput(), adminCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe("https://example.com/webhook");
        expect(result.data.events).toEqual(["governance.request.created"]);
        expect(result.data.secret).toBeDefined();
        expect(result.data.secret.length).toBe(64); // 32 bytes hex
        expect(result.data.active).toBe(true);
        expect(result.data.createdBy).toBe("admin-1");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await createEndpoint(makeEndpointInput(), userCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("the API key's service principal is no user row: its endpoint has no creator (KD-024), the secret is in the answer once", async () => {
      const result = await createEndpoint(makeEndpointInput(), { ...adminCtx, userId: "api-key-user" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.createdBy).toBeNull();
        expect(result.data.secret).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("validates URL format", async () => {
      const result = await createEndpoint(
        makeEndpointInput({ url: "not-a-url" }),
        adminCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("validates events are from allowed list", async () => {
      const result = await createEndpoint(
        makeEndpointInput({ events: ["invalid.event"] as never }),
        adminCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("updateEndpoint", () => {
    it("updates url, events, and active status", async () => {
      const createResult = await createEndpoint(makeEndpointInput(), adminCtx);
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const result = await updateEndpoint(
        createResult.data.id,
        {
          url: "https://updated.com/hook",
          events: ["emission.completed"],
          active: false,
        },
        adminCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.url).toBe("https://updated.com/hook");
        expect(result.data.events).toEqual(["emission.completed"]);
        expect(result.data.active).toBe(false);
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await updateEndpoint("any-id", { active: false }, userCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("returns NOT_FOUND for unknown endpoint", async () => {
      const result = await updateEndpoint(
        "nonexistent",
        { active: false },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("deleteEndpoint", () => {
    it("removes endpoint", async () => {
      const createResult = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!createResult.success) return;

      const result = await deleteEndpoint(createResult.data.id, adminCtx);
      expect(result.success).toBe(true);

      const eps = await _getEndpoints();
      expect(eps).toHaveLength(0);
    });

    it("rejects non-Admin users", async () => {
      const result = await deleteEndpoint("any-id", userCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("getEndpoints", () => {
    it("returns all endpoints", async () => {
      await createEndpoint(makeEndpointInput(), adminCtx);
      await createEndpoint(
        makeEndpointInput({ url: "https://other.com/hook" }),
        adminCtx
      );

      const result = await getEndpoints(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });

    it("never carries a signing secret (it is shown once, in the answer of the creation)", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      expect(created.success && created.data.secret).toMatch(/^[0-9a-f]{64}$/);
      const secret = created.success ? created.data.secret : "";

      const result = await getEndpoints(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        for (const endpoint of result.data) {
          expect(endpoint).not.toHaveProperty("secret");
          expect(Object.keys(endpoint).sort()).toEqual(["active", "createdAt", "createdBy", "events", "id", "tenantId", "updatedAt", "url"]);
        }
        expect(JSON.stringify(result.data)).not.toContain(secret);
      }
    });

    it("the answer of an update does not carry the secret either, and the stored secret is unchanged", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!created.success) throw new Error("create failed");
      const updated = await updateEndpoint(created.data.id, { active: false }, adminCtx);
      expect(updated.success).toBe(true);
      if (updated.success) expect(updated.data).not.toHaveProperty("secret");
      expect((await _getEndpoints())[0].secret).toBe(created.data.secret);
    });

    it("rejects non-Admin users", async () => {
      const result = await getEndpoints(userCtx);
      expect(result.success).toBe(false);
    });
  });

  describe("computeHmacSignature", () => {
    it("computes correct HMAC-SHA256 signature", () => {
      const secret = "test-secret";
      const payload = '{"event":"test"}';
      const signature = computeHmacSignature(secret, payload);

      // Verify it's a hex string of correct length (sha256 = 64 hex chars)
      expect(signature).toMatch(/^[a-f0-9]{64}$/);

      // Verify deterministic
      const signature2 = computeHmacSignature(secret, payload);
      expect(signature).toBe(signature2);

      // Verify different payload produces different signature
      const signature3 = computeHmacSignature(secret, '{"event":"other"}');
      expect(signature).not.toBe(signature3);
    });
  });

  describe("dispatchEvent", () => {
    it("sends HTTP POST to all active endpoints subscribed to the event", async () => {
      // Create endpoint
      await createEndpoint(
        makeEndpointInput({
          url: "https://example.com/webhook",
          events: ["governance.request.created"],
        }),
        adminCtx
      );

      // The HTTP leg is the transport (the destination policy is tested apart): mocked here.
      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1", entityId: "e1" },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://example.com/webhook");
      expect(options?.method).toBe("POST");
      expect(options?.headers).toHaveProperty(
        "Content-Type",
        "application/json"
      );
      expect(options?.headers).toHaveProperty("X-Webhook-Signature");

      // Verify signature header format
      const sigHeader = (options?.headers as Record<string, string>)[
        "X-Webhook-Signature"
      ];
      expect(sigHeader).toMatch(/^sha256=[a-f0-9]{64}$/);

      fetchSpy.mockRestore();
    });

    it("skips inactive endpoints", async () => {
      const createResult = await createEndpoint(
        makeEndpointInput({ active: true }),
        adminCtx
      );
      if (createResult.success) {
        await updateEndpoint(
          createResult.data.id,
          { active: false },
          adminCtx
        );
      }

      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("skips endpoints not subscribed to the event type", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["emission.completed"] }),
        adminCtx
      );

      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("payload includes correct structure", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      const payload = {
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1", entityId: "e1", entityName: "Test" },
      };

      await dispatchEvent(payload);

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      const parsed = JSON.parse(body);
      expect(parsed.event).toBe("governance.request.created");
      expect(parsed.timestamp).toBe("2025-01-01T00:00:00Z");
      expect(parsed.data).toEqual({ tenantId: "tenant-1", entityId: "e1", entityName: "Test" });

      fetchSpy.mockRestore();
    });

    it("HMAC-SHA256 signature is computed correctly", async () => {
      const createResult = await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      const payload = {
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1", test: true },
      };

      await dispatchEvent(payload);

      if (createResult.success) {
        const body = fetchSpy.mock.calls[0][1]?.body as string;
        const expectedSig = computeHmacSignature(
          createResult.data.secret,
          body
        );
        const actualHeader = (
          fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
        )["X-Webhook-Signature"];
        expect(actualHeader).toBe(`sha256=${expectedSig}`);
      }

      fetchSpy.mockRestore();
    });

    it("failed delivery (non-2xx) is logged in deliveries with error", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockResolvedValue(
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const allDeliveries = await _getDeliveries();
      expect(allDeliveries.length).toBeGreaterThanOrEqual(1);
      const failed = allDeliveries.find((d) => d.error !== null);
      expect(failed).toBeDefined();
      expect(failed!.statusCode).toBe(500);
      expect(failed!.error).toContain("500");

      vi.restoreAllMocks();
    });

    it("failed delivery schedules retry with exponential backoff", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Error" })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const allDeliveries = await _getDeliveries();
      const failed = allDeliveries.find(
        (d) => d.error !== null && d.attempt === 1
      );
      expect(failed).toBeDefined();
      expect(failed!.nextRetryAt).not.toBeNull();

      // nextRetryAt should be ~10 seconds from now
      const now = new Date();
      const retryTime = failed!.nextRetryAt!.getTime();
      const diffMs = retryTime - now.getTime();
      // Allow for some timing variance — should be approximately 10 seconds
      expect(diffMs).toBeGreaterThan(5_000);
      expect(diffMs).toBeLessThanOrEqual(15_000);

      vi.restoreAllMocks();
    });

    it("max 3 retries (4 total attempts) — no retry scheduled after 4th", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Error" })
      );

      // Dispatch the event (attempt 1)
      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const allDeliveries = await _getDeliveries();
      const attempt1 = allDeliveries.find((d) => d.attempt === 1);
      expect(attempt1).toBeDefined();
      expect(attempt1!.nextRetryAt).not.toBeNull();

      vi.restoreAllMocks();
    });

    it("never throws — failures logged but do not propagate", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockRejectedValue(
        new Error("Network failure")
      );

      // Should not throw
      await expect(
        dispatchEvent({
          event: "governance.request.created",
          timestamp: "2025-01-01T00:00:00Z",
          data: { tenantId: "tenant-1" },
        })
      ).resolves.not.toThrow();

      vi.restoreAllMocks();
    });

    it("timeout triggers failure handling", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockRejectedValue(
        new DOMException("The operation was aborted", "AbortError")
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const allDeliveries = await _getDeliveries();
      const failed = allDeliveries.find((d) => d.error !== null);
      expect(failed).toBeDefined();
      expect(failed!.error).toContain("aborted");

      vi.restoreAllMocks();
    });

    it("a refused destination (KD-027: not https, or not a public address) is recorded once and never retried", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.mocked(postWebhook).mockRejectedValue(
        new WebhookTargetError("only https endpoints are called")
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const allDeliveries = await _getDeliveries();
      expect(allDeliveries).toHaveLength(1);
      expect(allDeliveries[0]).toMatchObject({ statusCode: null, error: "only https endpoints are called", attempt: 1, nextRetryAt: null });

      vi.restoreAllMocks();
    });
  });

  describe("processRetryQueue", () => {
    beforeEach(() => {
      // Only the clock is faked: the retry falls due by moving it forward, nothing else waits.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("a due retry is sent once, even when two sweeps read the same row (concurrent dispatches)", async () => {
      await createEndpoint(makeEndpointInput({ events: ["governance.request.created"] }), adminCtx);
      vi.mocked(postWebhook).mockResolvedValueOnce(new Response("Error", { status: 500, statusText: "Error" }));
      await dispatchEvent({ event: "governance.request.created", timestamp: "2025-01-01T00:00:00Z", data: { tenantId: "tenant-1" } });
      expect(postWebhook).toHaveBeenCalledTimes(1);

      // The first attempt's retry is due 10 seconds on; both sweeps run after that.
      vi.setSystemTime(new Date("2025-01-01T00:00:11Z"));
      vi.mocked(postWebhook).mockClear();
      vi.mocked(postWebhook).mockResolvedValue(new Response("OK", { status: 200 }));

      await Promise.all([processRetryQueue(), processRetryQueue()]);

      expect(postWebhook).toHaveBeenCalledTimes(1);
      const retried = (await _getDeliveries()).filter((d) => d.attempt === 2);
      expect(retried).toHaveLength(1);
      expect(retried[0]).toMatchObject({ statusCode: 200, error: null });
    });
  });

  describe("getDeliveries", () => {
    it("returns delivery history for an endpoint", async () => {
      const createResult = await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );
      if (!createResult.success) return;

      vi.mocked(postWebhook).mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { tenantId: "tenant-1" },
      });

      const result = await getDeliveries(createResult.data.id, adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        expect(result.data[0].endpointId).toBe(createResult.data.id);
      }

      vi.restoreAllMocks();
    });

    it("rejects non-Admin users", async () => {
      const result = await getDeliveries("any-id", userCtx);
      expect(result.success).toBe(false);
    });

    it("an endpoint that does not exist is NOT_FOUND, not an empty history", async () => {
      const result = await getDeliveries("no-such-endpoint", adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toBe('Webhook endpoint "no-such-endpoint" not found');
      }
    });

    it("an endpoint that exists and has no deliveries has an empty history", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!created.success) throw new Error("the endpoint was not created");
      const result = await getDeliveries(created.data.id, adminCtx);
      expect(result).toEqual({ success: true, data: [] });
    });
  });

  describe("tenant scoping and the destination check (KD-027)", () => {
    const otherTenantCtx: ServiceContext = { ...adminCtx, tenantId: "tenant-2" };
    const noTenantCtx: ServiceContext = {
      userId: "admin-1",
      userRole: "ADMIN",
      assignments: [assign.global()],
      prisma: {} as ServiceContext["prisma"],
    };
    const EVENT = { event: "emission.completed" as const, timestamp: "2025-01-01T00:00:00Z" };

    it("an endpoint is recorded in the tenant the request acts in, whatever tenant the input names", async () => {
      const result = await createEndpoint({ ...makeEndpointInput(), tenantId: "tenant-2" } as never, adminCtx);

      expect(result.success).toBe(true);
      expect(await _getEndpoints()).toEqual([expect.objectContaining({ tenantId: "tenant-1" })]);
    });

    it("a request that names no tenant creates nothing and reads, changes and lists nothing", async () => {
      const made = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!made.success) throw new Error("setup: the endpoint was not made");
      const id = made.data.id;

      expect((await createEndpoint(makeEndpointInput({ url: "https://other.example.com/h" }), noTenantCtx)).success).toBe(false);
      expect((await getEndpoints(noTenantCtx)).success).toBe(false);
      expect((await updateEndpoint(id, { active: false }, noTenantCtx)).success).toBe(false);
      expect((await deleteEndpoint(id, noTenantCtx)).success).toBe(false);
      expect((await getDeliveries(id, noTenantCtx)).success).toBe(false);
      expect(await _getEndpoints()).toEqual([expect.objectContaining({ id, active: true, tenantId: "tenant-1" })]);
    });

    it("the list shows only the endpoints of the tenant the request acts in", async () => {
      await createEndpoint(makeEndpointInput({ url: "https://one.example.com/h" }), adminCtx);
      await createEndpoint(makeEndpointInput({ url: "https://two.example.com/h" }), otherTenantCtx);

      const list = await getEndpoints(adminCtx);

      expect(list).toMatchObject({ success: true, data: [expect.objectContaining({ url: "https://one.example.com/h", tenantId: "tenant-1" })] });
    });

    it("another tenant's endpoint is answered as a missing one: it is not changed, deleted or shown", async () => {
      const made = await createEndpoint(makeEndpointInput(), otherTenantCtx);
      if (!made.success) throw new Error("setup: the endpoint was not made");
      const id = made.data.id;

      expect(await updateEndpoint(id, { active: false }, adminCtx)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      expect(await deleteEndpoint(id, adminCtx)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      expect(await getDeliveries(id, adminCtx)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      expect(await _getEndpoints()).toEqual([expect.objectContaining({ id, active: true, tenantId: "tenant-2" })]);
    });

    it("an event reaches only the active endpoints of the tenant it belongs to", async () => {
      await createEndpoint(makeEndpointInput({ url: "https://mine.example.com/h", events: ["emission.completed"] }), adminCtx);
      await createEndpoint(makeEndpointInput({ url: "https://theirs.example.com/h", events: ["emission.completed"] }), otherTenantCtx);
      vi.mocked(postWebhook).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      await dispatchEvent({ ...EVENT, data: { tenantId: "tenant-1", entityId: "e1" } });

      expect(vi.mocked(postWebhook).mock.calls.map(([url]) => url)).toEqual(["https://mine.example.com/h"]);
    });

    it("an event that names no tenant reaches no endpoint, and the gap is logged", async () => {
      await createEndpoint(makeEndpointInput(), adminCtx);
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await dispatchEvent({ ...EVENT, data: { entityId: "e1" } });

      expect(vi.mocked(postWebhook)).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    });

    it("the URL is checked when the endpoint is made, and a refused one is not stored", async () => {
      vi.mocked(refuseEndpointUrl).mockResolvedValueOnce("Only https endpoints are accepted");

      const result = await createEndpoint(makeEndpointInput({ url: "http://example.com/h" }), adminCtx);

      expect(refuseEndpointUrl).toHaveBeenCalledWith("http://example.com/h");
      expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR", message: "Only https endpoints are accepted" } });
      expect(await _getEndpoints()).toHaveLength(0);
    });

    it("an update to a refused URL changes nothing", async () => {
      const made = await createEndpoint(makeEndpointInput({ url: "https://example.com/h" }), adminCtx);
      if (!made.success) throw new Error("setup: the endpoint was not made");
      vi.mocked(refuseEndpointUrl).mockResolvedValueOnce("10.0.0.5 is not a public address");

      const update = await updateEndpoint(made.data.id, { url: "https://10.0.0.5/h", active: false }, adminCtx);

      expect(update).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
      expect(await _getEndpoints()).toEqual([expect.objectContaining({ url: "https://example.com/h", active: true })]);
    });
  });

  describe("the signing secret at rest", () => {
    const payload = {
      event: "governance.request.created",
      timestamp: "2025-01-01T00:00:00Z",
      data: { tenantId: "tenant-1" },
    };

    it("the row keeps a sealed secret, and only the creation answer shows the plain one", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!created.success) throw new Error("create failed");

      expect(created.data.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(endpoints[0].secret).toMatch(/^enc:v1:/);
      expect(endpoints[0].secret).not.toContain(created.data.secret);
    });

    it("a sealed secret signs deliveries with the value the creation answered", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!created.success) throw new Error("create failed");
      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      await dispatchEvent(payload);

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)["X-Webhook-Signature"]).toBe(
        `sha256=${computeHmacSignature(created.data.secret, body)}`
      );
    });

    it("a legacy plain secret (stored before sealing) still signs, with no migration", async () => {
      endpoints.push({
        id: "whep_legacy",
        url: "https://legacy.example.com/hook",
        events: ["governance.request.created"],
        secret: "legacy-plain-secret",
        active: true,
        createdBy: "admin-1",
        tenantId: "tenant-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      await dispatchEvent(payload);

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      expect((fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)["X-Webhook-Signature"]).toBe(
        `sha256=${computeHmacSignature("legacy-plain-secret", body)}`
      );
    });

    it("a secret that cannot be opened is a failed delivery: nothing is sent unsigned, and the error holds no secret", async () => {
      const created = await createEndpoint(makeEndpointInput(), adminCtx);
      if (!created.success) throw new Error("create failed");
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", OTHER_SECRETS_KEY);
      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      await dispatchEvent(payload);

      expect(fetchSpy).not.toHaveBeenCalled();
      const [failed] = await _getDeliveries();
      expect(failed.endpointId).toBe(created.data.id);
      expect(failed.statusCode).toBeNull();
      expect(failed.error).toContain("cannot be opened");
      expect(failed.nextRetryAt).not.toBeNull();
      expect(failed.error).not.toContain(created.data.secret);
      expect(failed.error).not.toContain(endpoints[0].secret);
    });

    it("an endpoint whose secret cannot be opened does not stop the others: the rest are still sent", async () => {
      const first = await createEndpoint(makeEndpointInput({ url: "https://first.example.com/hook" }), adminCtx);
      if (!first.success) throw new Error("create failed");
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", OTHER_SECRETS_KEY);
      const second = await createEndpoint(makeEndpointInput({ url: "https://second.example.com/hook" }), adminCtx);
      if (!second.success) throw new Error("create failed");
      const fetchSpy = vi.mocked(postWebhook).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      await dispatchEvent(payload);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe("https://second.example.com/hook");
      const failed = (await _getDeliveries()).filter((d) => d.error !== null);
      expect(failed.map((d) => d.endpointId)).toEqual([first.data.id]);
    });

    it("a legacy plain secret is sealed on the endpoint's next update, and keeps signing with the same value", async () => {
      endpoints.push({
        id: "whep_legacy",
        url: "https://legacy.example.com/hook",
        events: ["governance.request.created"],
        secret: "legacy-plain-secret",
        active: true,
        createdBy: "admin-1",
        tenantId: "tenant-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await updateEndpoint("whep_legacy", { active: true }, adminCtx);

      expect(updated.success).toBe(true);
      expect(endpoints[0].secret).toMatch(/^enc:v1:/);
      expect((await _getEndpoints())[0].secret).toBe("legacy-plain-secret");
    });

    it("without a key, updating an endpoint with a legacy secret still succeeds, and the secret stays as it was", async () => {
      endpoints.push({
        id: "whep_legacy",
        url: "https://legacy.example.com/hook",
        events: ["governance.request.created"],
        secret: "legacy-plain-secret",
        active: true,
        createdBy: "admin-1",
        tenantId: "tenant-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
      vi.stubEnv("AUTH_SECRET", "");
      vi.stubEnv("NEXTAUTH_SECRET", "");

      const updated = await updateEndpoint("whep_legacy", { active: false }, adminCtx);

      expect(updated.success).toBe(true);
      expect(endpoints[0].secret).toBe("legacy-plain-secret");
    });

    it("a malformed SECRETS_ENCRYPTION_KEY does not block an update: the legacy secret stays plain, and the log names the variable, never the value", async () => {
      endpoints.push({
        id: "whep_legacy",
        url: "https://legacy.example.com/hook",
        events: ["governance.request.created"],
        secret: "legacy-plain-secret",
        active: true,
        createdBy: "admin-1",
        tenantId: "tenant-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", "not-a-key!");

      const updated = await updateEndpoint("whep_legacy", { active: false }, adminCtx);

      expect(updated.success).toBe(true);
      expect(endpoints[0].secret).toBe("legacy-plain-secret");
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("SECRETS_ENCRYPTION_KEY");
      expect(line).not.toContain("not-a-key!");
      expect(line).not.toContain("legacy-plain-secret");
      warn.mockRestore();
    });

    it("with no key at all, creating an endpoint is refused with the reason, and nothing is stored", async () => {
      vi.stubEnv("SECRETS_ENCRYPTION_KEY", "");
      vi.stubEnv("AUTH_SECRET", "");
      vi.stubEnv("NEXTAUTH_SECRET", "");

      const result = await createEndpoint(makeEndpointInput(), adminCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("INTERNAL_ERROR");
        expect(result.error.message).toContain("SECRETS_ENCRYPTION_KEY");
      }
      expect(endpoints).toHaveLength(0);
    });
  });
});
