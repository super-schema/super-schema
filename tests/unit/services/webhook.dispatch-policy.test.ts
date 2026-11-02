// @vitest-environment node
/**
 * The dispatch of a webhook event through the REAL transport (KD-027): the destination policy is not mocked here, so a refused endpoint is shown
 * to make no connection and to be recorded as one failed delivery. Only the connection itself is stubbed (`https.request`), so no socket opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import https from "node:https";

const store = vi.hoisted(() => ({
  endpoints: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    webhookEndpoint: {
      // The filter the dispatch asks for: active, the event's tenant, and a subscribed event.
      findMany: vi.fn(async ({ where }: { where: { active: boolean; tenantId: string; events: { hasSome: string[] } } }) =>
        store.endpoints.filter(
          (endpoint) =>
            endpoint.active === where.active &&
            // An absent filter is no filter, as in Prisma: a query without a tenant would reach every tenant's endpoint.
            (where.tenantId === undefined || endpoint.tenantId === where.tenantId) &&
            (endpoint.events as string[]).some((event) => where.events.hasSome.includes(event))
        )
      ),
    },
    webhookDelivery: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `whdl_${store.deliveries.length + 1}`, deliveredAt: new Date(), statusCode: null, error: null, attempt: 1, nextRetryAt: null, ...data };
        store.deliveries.push(row);
        return row;
      }),
      findMany: vi.fn(async () => []),
    },
  },
}));

import { dispatchEvent } from "@/services/webhook.service";

const payload = { event: "governance.request.created" as const, timestamp: "2025-01-01T00:00:00Z", data: { tenantId: "tenant-1" } };

const endpoint = (url: string, tenantId = "tenant-1") => ({
  id: "whep_1",
  url,
  events: ["governance.request.created"],
  secret: "a".repeat(64),
  active: true,
  createdBy: null,
  tenantId,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/** The connection stands in: it answers 200 and records each connection it is asked for. */
function stubConnection() {
  return vi.spyOn(https, "request").mockImplementation(((_url: unknown, _options: unknown, callback?: (res: unknown) => void) => {
    const req = {
      on: () => req,
      end: () => callback?.({ statusCode: 200, statusMessage: "OK", resume: () => undefined }),
    };
    return req;
  }) as unknown as typeof https.request);
}

beforeEach(() => {
  store.endpoints = [];
  store.deliveries = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchEvent through the destination policy (KD-027)", () => {
  it("an endpoint of another tenant is not connected to, even when its address is public", async () => {
    store.endpoints = [endpoint("https://8.8.8.8/hook", "tenant-2")];
    const connection = stubConnection();

    await dispatchEvent(payload);

    expect(connection).not.toHaveBeenCalled();
    expect(store.deliveries).toHaveLength(0);
  });

  it("an http endpoint is refused: no connection is made, and the refusal is one failed delivery that is never retried", async () => {
    store.endpoints = [endpoint("http://8.8.8.8/hook")];
    const connection = stubConnection();

    await expect(dispatchEvent(payload)).resolves.toBeUndefined();

    expect(connection).not.toHaveBeenCalled();
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ endpointId: "whep_1", statusCode: null, error: "only https endpoints are called", attempt: 1, nextRetryAt: null });
  });

  it("an https endpoint on a private address is refused the same way", async () => {
    store.endpoints = [endpoint("https://10.0.0.5/hook")];
    const connection = stubConnection();

    await dispatchEvent(payload);

    expect(connection).not.toHaveBeenCalled();
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ statusCode: null, error: "10.0.0.5 is not a public address", nextRetryAt: null });
  });

  it("a public https endpoint is connected to once, and its answer is recorded", async () => {
    store.endpoints = [endpoint("https://8.8.8.8/hook")];
    const connection = stubConnection();

    await dispatchEvent(payload);

    expect(connection).toHaveBeenCalledTimes(1);
    expect(connection.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ statusCode: 200, error: null });
  });
});
