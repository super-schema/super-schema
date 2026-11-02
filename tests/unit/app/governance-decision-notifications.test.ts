// @vitest-environment node
/**
 * A governance decision (`approveGovernanceRequestAction`, `rejectGovernanceRequestAction`) schedules, AFTER the answer, the requestor's in-app
 * notification and the `governance.request.approved|rejected` delivery. Nothing is scheduled for a decision that was refused or that the service
 * refused, and a failing notification never changes the answer. The REAL guard and the REAL trigger module run; the database, the session, the
 * decision service and the webhook receiver are stand-ins, and `after` is captured so the test can run the work once the answer is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, signInAs, userRow } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  activeTenant: vi.fn(),
  revalidatePath: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  scheduled: [] as Array<() => Promise<unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
  endpoints: [] as Array<Record<string, unknown>>,
  users: {} as Record<string, unknown>,
  entities: {} as Record<string, unknown>,
  requests: {} as Record<string, unknown>,
  prisma: {
    governanceRequest: { findUnique: vi.fn() },
    entity: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    webhookEndpoint: { findMany: vi.fn() },
    webhookDelivery: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

const webhookReceiver = vi.hoisted(() => ({ postWebhook: vi.fn() }));
vi.mock("@/lib/webhook-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhook-transport")>()),
  postWebhook: webhookReceiver.postWebhook,
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Inside a request `after` keeps the task for once the answer is sent; the test runs it then.
  after: (task: () => Promise<unknown>) => {
    h.scheduled.push(task);
  },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/services/governance.service", () => ({ getAllRequests: vi.fn(), approveRequest: h.approve, rejectRequest: h.reject }));

import { approveGovernanceRequestAction, rejectGovernanceRequestAction } from "@/app/(dashboard)/governance/actions";

const T = "tenant-1";
const OTHER = "tenant-2";

/** Runs what the actions scheduled, as the server does once the answer has gone out. */
async function runScheduled(): Promise<void> {
  for (const task of h.scheduled.splice(0)) await task();
}

/** `req-1` asks about `entity-1` (UserProfile, version 2 of tenant 1, domain dom-a) and was made by `requestor-1`. */
function seed() {
  h.requests["req-1"] = { id: "req-1", entityId: "entity-1", entityName: "UserProfile", versionId: "2", requestedBy: "requestor-1", status: "PENDING" };
  h.entities["entity-1"] = {
    id: "entity-1", tenantId: T, name: "UserProfile", slug: "userprofile", version: 2, ownerId: "owner-1", domainId: "dom-a", productId: "prod-a",
    product: { domainId: "dom-a", slug: "prod-a" }, domain: { id: "dom-a", slug: "sales", name: "sales" }, fields: [],
  };
  h.users = {
    "steward-1": userRow([assign.domain("STEWARD", T, "dom-a")], { id: "steward-1", email: "steward@example.test" }),
    "requestor-1": userRow([assign.domain("AUTHOR", T, "dom-a")], { id: "requestor-1", email: "requestor@example.test" }),
    "former-1": userRow([], { id: "former-1", email: "former@example.test" }),
  };
  (h.users["steward-1"] as { name?: string }).name = "Jane Steward";
  (h.users["requestor-1"] as { name?: string }).name = "Rita Requestor";
  h.endpoints = [];
}

const steward = () => principalOf([assign.domain("STEWARD", T, "dom-a")], { userId: "steward-1", email: "steward@example.test" });

beforeEach(() => {
  vi.clearAllMocks();
  h.scheduled.splice(0);
  h.notifications.splice(0);
  h.deliveries.splice(0);
  seed();
  h.activeTenant.mockResolvedValue(T);
  h.prisma.governanceRequest.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => h.requests[where.id] ?? null);
  h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => h.entities[where.id] ?? null);
  h.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const row = h.users[where.id] as { name?: string } | undefined;
    return row ? { ...row, name: row.name ?? null } : null;
  });
  h.prisma.notification.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `n-${h.notifications.length + 1}`, read: false, createdAt: new Date(), ...data };
    h.notifications.push(row);
    return row;
  });
  h.prisma.webhookEndpoint.findMany.mockImplementation(async ({ where }: { where: { events: { hasSome: string[] } } }) =>
    h.endpoints.filter((endpoint) => (endpoint.events as string[]).some((event) => where.events.hasSome.includes(event)))
  );
  h.prisma.webhookDelivery.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `d-${h.deliveries.length + 1}`, nextRetryAt: null, deliveredAt: new Date(), attempt: 1, error: null, ...data };
    h.deliveries.push(row);
    return row;
  });
  h.prisma.webhookDelivery.findMany.mockResolvedValue([]);
  h.prisma.webhookDelivery.update.mockResolvedValue(null);
  h.endpoints.push({
    id: "w1", url: "https://hooks.example.test/w1", events: ["governance.request.approved", "governance.request.rejected"], secret: "s".repeat(64),
    active: true, createdBy: null, createdAt: new Date(), updatedAt: new Date(),
  });
  h.approve.mockResolvedValue({ success: true, data: { id: "apr-1", requestId: "req-1", approverId: "steward-1", decision: "APPROVED", comment: "ok", decidedAt: "2026-11-01T00:00:00.000Z" } });
  h.reject.mockResolvedValue({ success: true, data: { id: "apr-2", requestId: "req-1", approverId: "steward-1", decision: "REJECTED", comment: "no", decidedAt: "2026-11-01T00:00:00.000Z" } });
  webhookReceiver.postWebhook.mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(steward());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a governance decision schedules its notifications after the answer", () => {
  it("approve: the answer comes first; the requestor is told, by the decider's name, and the approved event goes out", async () => {
    const answer = await approveGovernanceRequestAction("req-1", "ok");

    expect(answer).toMatchObject({ success: true });
    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.scheduled).toHaveLength(1);

    await runScheduled();

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({ userId: "requestor-1", type: "APPROVAL_DECISION" });
    expect(h.notifications[0].title).toBe("Your change to UserProfile was approved by Jane Steward");
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({ endpointId: "w1", event: "governance.request.approved", statusCode: 200 });
    expect(h.deliveries[0].payload).toMatchObject({
      event: "governance.request.approved",
      data: { tenantId: T, entityId: "entity-1", entityName: "UserProfile", decision: "approved", stewardName: "Jane Steward" },
    });
  });

  it("reject: the requestor is told it was rejected, and the rejected event goes out", async () => {
    signInAs(steward());

    expect(await rejectGovernanceRequestAction("req-1", "no")).toMatchObject({ success: true });
    await runScheduled();

    expect(h.notifications[0]).toMatchObject({ userId: "requestor-1", title: "Your change to UserProfile was rejected by Jane Steward" });
    expect(h.deliveries.map((row) => row.event)).toEqual(["governance.request.rejected"]);
  });

  it("a requestor who no longer holds a role on the entity is not told, and the event still goes out", async () => {
    h.requests["req-1"] = { ...(h.requests["req-1"] as object), requestedBy: "former-1" };

    await approveGovernanceRequestAction("req-1", null);
    await runScheduled();

    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries.map((row) => row.event)).toEqual(["governance.request.approved"]);
  });

  it("a decision made with the API key names the key as the decider", async () => {
    signInAs(principalOf([assign.global()], { userId: "api-key-user", email: "api-key@example.test" }));

    await approveGovernanceRequestAction("req-1", null);
    await runScheduled();

    expect(h.notifications[0].title).toBe("Your change to UserProfile was approved by the API key");
  });

  it("a decision that is refused (no steward role on the entity) schedules nothing", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")], { userId: "author-1" }));

    const answer = await approveGovernanceRequestAction("req-1", null);

    expect(answer).toMatchObject({ error: expect.any(String) });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.scheduled).toHaveLength(0);
  });

  it("a decision on a request of another tenant schedules nothing", async () => {
    h.entities["entity-1"] = { ...(h.entities["entity-1"] as object), tenantId: OTHER };
    h.activeTenant.mockResolvedValue(T);

    expect(await approveGovernanceRequestAction("req-1", null)).toEqual({ error: 'Governance request "req-1" not found' });
    expect(h.scheduled).toHaveLength(0);
  });

  it("a decision the service refuses (already decided) schedules nothing", async () => {
    h.approve.mockResolvedValue({ success: false, error: { code: "INVALID_STATE", message: "Cannot approve request with status \"APPROVED\"" } });

    expect(await approveGovernanceRequestAction("req-1", null)).toEqual({ error: 'Cannot approve request with status "APPROVED"' });
    expect(h.scheduled).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });

  it("a failing notification never changes the answer: the decision stands, and the failure is logged", async () => {
    h.prisma.webhookEndpoint.findMany.mockRejectedValue(new Error("DB connection failed"));

    const answer = await approveGovernanceRequestAction("req-1", "ok");
    expect(answer).toMatchObject({ success: true, data: { decision: "APPROVED" } });

    await expect(runScheduled()).resolves.toBeUndefined();
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });
});
