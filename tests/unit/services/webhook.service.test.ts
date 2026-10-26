import { describe, it, expect, vi, beforeEach } from "vitest";

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
      deleteMany: vi.fn(async () => {
        deliveries = [];
        dlCounter = 0;
      }),
    },
  },
}));

import {
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  getEndpoints,
  getDeliveries,
  dispatchEvent,
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

describe("Webhook Service", () => {
  beforeEach(async () => {
    await _resetStore();
    vi.restoreAllMocks();
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
          expect(Object.keys(endpoint).sort()).toEqual(["active", "createdAt", "createdBy", "events", "id", "updatedAt", "url"]);
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

      // Mock fetch
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { entityId: "e1" },
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

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("skips endpoints not subscribed to the event type", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["emission.completed"] }),
        adminCtx
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("payload includes correct structure", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      const payload = {
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { entityId: "e1", entityName: "Test" },
      };

      await dispatchEvent(payload);

      const body = fetchSpy.mock.calls[0][1]?.body as string;
      const parsed = JSON.parse(body);
      expect(parsed.event).toBe("governance.request.created");
      expect(parsed.timestamp).toBe("2025-01-01T00:00:00Z");
      expect(parsed.data).toEqual({ entityId: "e1", entityName: "Test" });

      fetchSpy.mockRestore();
    });

    it("HMAC-SHA256 signature is computed correctly", async () => {
      const createResult = await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      const payload = {
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: { test: true },
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

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
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

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Error" })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
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

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Error", { status: 500, statusText: "Error" })
      );

      // Dispatch the event (attempt 1)
      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
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

      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Network failure")
      );

      // Should not throw
      await expect(
        dispatchEvent({
          event: "governance.request.created",
          timestamp: "2025-01-01T00:00:00Z",
          data: {},
        })
      ).resolves.not.toThrow();

      vi.restoreAllMocks();
    });

    it("timeout triggers failure handling", async () => {
      await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );

      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new DOMException("The operation was aborted", "AbortError")
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
      });

      const allDeliveries = await _getDeliveries();
      const failed = allDeliveries.find((d) => d.error !== null);
      expect(failed).toBeDefined();
      expect(failed!.error).toContain("aborted");

      vi.restoreAllMocks();
    });
  });

  describe("getDeliveries", () => {
    it("returns delivery history for an endpoint", async () => {
      const createResult = await createEndpoint(
        makeEndpointInput({ events: ["governance.request.created"] }),
        adminCtx
      );
      if (!createResult.success) return;

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );

      await dispatchEvent({
        event: "governance.request.created",
        timestamp: "2025-01-01T00:00:00Z",
        data: {},
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
});
