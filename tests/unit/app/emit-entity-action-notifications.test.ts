/**
 * `emitEntityAction` (the UI's emit of every target) schedules the emission notification AFTER the answer, and only for a run that completed: no
 * refusal and no invalid target. The answer is unchanged. Prisma, auth, the emission orchestrator and the webhook receiver are stand-ins; the trigger
 * module is the real one; `after` is captured so the test can run the work once the answer is back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, userRow } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  emitEntity: vi.fn(),
  scheduled: [] as Array<() => Promise<unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
  endpoints: [] as Array<Record<string, unknown>>,
  users: {} as Record<string, unknown>,
  prisma: {
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
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Inside a request `after` keeps the task for once the answer is sent; the test runs it then.
  after: (task: () => Promise<unknown>) => {
    h.scheduled.push(task);
  },
}));
vi.mock("@/lib/emission/emission.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/emission/emission.service")>()),
  emitEntity: h.emitEntity,
}));

import { emitEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

/** Runs what the action scheduled, as the server does once the answer has gone out. */
async function runScheduled(): Promise<void> {
  for (const task of h.scheduled.splice(0)) await task();
}

/** `ent-1`: an order of tenant 1 that user `owner-1` owns, version 1. */
const ENTITY = {
  id: "ent-1", tenantId: "tenant-1", name: "Order", slug: "order", version: 1, ownerId: "owner-1", domainId: "d-sales", productId: "p-orders",
  product: { domainId: "d-sales" }, domain: { id: "d-sales", name: "sales", slug: "sales" }, fields: [],
};

const RUN = (overrides: Record<string, unknown> = {}) => ({
  typespec: "",
  targets: {},
  success: true,
  summary: { totalTargets: 8, validCount: 8, warningCount: 0, invalidCount: 0 },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.scheduled.splice(0);
  h.notifications.splice(0);
  h.deliveries.splice(0);
  h.endpoints.splice(0);
  h.users = { "owner-1": userRow([assign.tenant("AUTHOR", "tenant-1")], { id: "owner-1", email: "owner@example.test" }) };
  h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "ent-1" ? ENTITY : null));
  h.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (h.users[where.id] as object | undefined) ?? null);
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
  h.endpoints.push({ id: "w1", url: "https://hooks.example.test/w1", events: ["emission.completed"], secret: "s".repeat(64), active: true, createdBy: null });
  webhookReceiver.postWebhook.mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("emitEntityAction: the emission notification", () => {
  it("a run that completed with no invalid target is answered as before; the owner and the endpoints are told after the answer", async () => {
    h.emitEntity.mockResolvedValue(RUN());

    const answer = await emitEntityAction("ent-1");

    expect(answer).toEqual({ success: true, result: expect.objectContaining({ success: true }) });
    expect(h.notifications).toHaveLength(0);
    expect(h.scheduled).toHaveLength(1);

    await runScheduled();

    expect(h.notifications).toEqual([expect.objectContaining({ userId: "owner-1", type: "CHANGE_COMPLETE", title: "Order v1 emitted to 8 targets" })]);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0].payload).toMatchObject({ event: "emission.completed", data: { tenantId: "tenant-1", entityId: "ent-1", targetCount: 8 } });
  });

  it("a run the closure refused, asking back for a name, did not complete: nothing is scheduled", async () => {
    h.emitEntity.mockResolvedValue(
      RUN({
        success: false,
        summary: { totalTargets: 8, validCount: 0, warningCount: 0, invalidCount: 8 },
        refusal: { code: "AMBIGUOUS_REFERENCE", message: "Choose.", details: { field: "addr", name: "Address", candidates: [], entityId: "ent-1", fieldId: "f1" } },
      })
    );

    const answer = await emitEntityAction("ent-1");

    expect(answer).toHaveProperty("needsReference");
    expect(h.scheduled).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });

  it("a run with an invalid target did not complete: nothing is scheduled", async () => {
    h.emitEntity.mockResolvedValue(RUN({ success: false, summary: { totalTargets: 8, validCount: 7, warningCount: 0, invalidCount: 1 } }));

    await emitEntityAction("ent-1");

    expect(h.scheduled).toHaveLength(0);
  });

  it("a failing notification never changes the answer", async () => {
    h.emitEntity.mockResolvedValue(RUN());
    h.prisma.webhookEndpoint.findMany.mockRejectedValue(new Error("DB connection failed"));

    const answer = await emitEntityAction("ent-1");

    expect(answer).toEqual({ success: true, result: expect.objectContaining({ success: true }) });
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
