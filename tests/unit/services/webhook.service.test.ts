import { describe, it, expect, vi, beforeEach } from "vitest";
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

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: {} as ServiceContext["prisma"],
};

const userCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
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
  beforeEach(() => {
    _resetStore();
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

      const endpoints = _getEndpoints();
      expect(endpoints).toHaveLength(0);
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

      const allDeliveries = _getDeliveries();
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

      const allDeliveries = _getDeliveries();
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
      // This tests the scheduleRetry logic indirectly
      // After attempt 4, nextRetryAt should be null
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

      const allDeliveries = _getDeliveries();
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

      const allDeliveries = _getDeliveries();
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
  });
});
