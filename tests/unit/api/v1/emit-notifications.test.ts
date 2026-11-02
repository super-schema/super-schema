// @vitest-environment node
/**
 * `POST /api/v1/schemas/:id/emit` and its emission notification. A run that completed with no invalid target schedules, AFTER the answer
 * (`after` from next/server, captured here so the test can run it once the answer is back), the in-app notification of the entity's owner and the
 * `emission.completed` delivery to every endpoint that asked for it. A refused run, or one with an invalid target, schedules nothing. A failing
 * notification never changes the answer. Through the REAL guard, principal loader, entity service and trigger module; the database, the session,
 * the emission orchestrator and the webhook receiver are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";
import type { Assignment } from "@/lib/access";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  activeTenant: vi.fn(),
  emitTargets: vi.fn(),
  scheduled: [] as Array<() => Promise<unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
  endpoints: [] as Array<Record<string, unknown>>,
  users: {} as Record<string, unknown>,
  entities: {} as Record<string, unknown>,
  prisma: {
    user: { findUnique: vi.fn() },
    entity: { findUnique: vi.fn() },
    field: { findMany: vi.fn() },
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
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/active-tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/active-tenant")>()), getActiveTenantId: h.activeTenant }));
vi.mock("@/app/api/v1/rate-limit", () => ({ checkRateLimit: () => null }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Inside a request `after` keeps the task for once the answer is sent; the test runs it then.
  after: (task: () => Promise<unknown>) => {
    h.scheduled.push(task);
  },
}));
vi.mock("@/lib/emission/emission.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/emission/emission.service")>()),
  emitTargetsForEntity: h.emitTargets,
}));
vi.mock("@/lib/compiler/typespec-generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compiler/typespec-generator")>();
  return { ...actual, generateTypeSpec: vi.fn(actual.generateTypeSpec) };
});

import { POST as emitSchema } from "@/app/api/v1/schemas/[id]/emit/route";

const SAVED = { ...process.env };
const KEY = "the-key-of-the-run";
const T = "t1";

const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (path: string, init: RequestInit = {}) => new Request(`http://localhost/api/v1${path}`, { method: "POST", ...init });
const bodyOf = async (response: Response) => JSON.parse(await response.text());

/** Runs what the route scheduled, as the server does once the answer has gone out. Each task is the one `runAfterResponse` registered. */
async function runScheduled(): Promise<void> {
  for (const task of h.scheduled.splice(0)) await task();
}

/** The caller (`user-1`) holds `assignments`; the owner of the entity is `owner-1`, who holds `ownerAssignments`. */
function signIn(assignments: Assignment[], ownerAssignments: Assignment[] = [assign.domain("AUTHOR", T, "d-sales")]) {
  h.auth.mockResolvedValue(sessionOf("user-1"));
  h.users["user-1"] = userRow(assignments, { id: "user-1" });
  h.users["owner-1"] = userRow(ownerAssignments, { id: "owner-1", email: "owner@example.test" });
}

/** `order`: a sales entity of tenant T, owned by `owner-1`, version 1. Every reader gets the same row; each reads only what it selected. */
function seedOrder() {
  h.entities.order = {
    id: "order", tenantId: T, name: "Order", description: "", status: "DRAFT", version: 1, ownerId: "owner-1", metadata: null, latestVersionId: null,
    hasUnpublishedChanges: true, typespecSource: null, parentEntityId: null, domainId: "d-sales", productId: "p-orders",
    domain: { id: "d-sales", name: "sales", slug: "sales" }, product: { name: "orders", domainId: "d-sales" }, fields: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
}

const TARGETS = ["json-schema", "openapi3"];
/** The run of the emission orchestrator: every target valid (or none invalid). */
function runOf(validationStatus: "VALID" | "INVALID" = "VALID") {
  return {
    results: TARGETS.map((key) => ({ target: { key }, result: { output: `${key} output`, validationStatus, warnings: [], errors: [] } })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.scheduled.splice(0);
  h.notifications.splice(0);
  h.deliveries.splice(0);
  h.endpoints.splice(0);
  for (const key of Object.keys(h.users)) delete h.users[key];
  for (const key of Object.keys(h.entities)) delete h.entities[key];
  seedOrder();
  delete process.env.API_KEY;
  delete process.env.API_KEY_ROLE;
  delete process.env.API_KEY_TENANT_ID;
  h.activeTenant.mockResolvedValue(T);
  h.prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => h.users[where.id] ?? null);
  h.prisma.entity.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => h.entities[where.id] ?? null);
  h.prisma.field.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `n-${h.notifications.length + 1}`, read: false, createdAt: new Date(), ...data };
    h.notifications.push(row);
    return row;
  });
  h.prisma.webhookEndpoint.findMany.mockImplementation(async ({ where }: { where: { tenantId?: string; events: { hasSome: string[] } } }) =>
    h.endpoints.filter(
      (endpoint) =>
        (where.tenantId === undefined || endpoint.tenantId === where.tenantId) &&
        (endpoint.events as string[]).some((event) => where.events.hasSome.includes(event))
    )
  );
  h.prisma.webhookDelivery.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `d-${h.deliveries.length + 1}`, nextRetryAt: null, deliveredAt: new Date(), attempt: 1, error: null, ...data };
    h.deliveries.push(row);
    return row;
  });
  // The retry queue asks for the rows with a `nextRetryAt`; every delivery here succeeds, so there are none.
  h.prisma.webhookDelivery.findMany.mockResolvedValue([]);
  h.prisma.webhookDelivery.update.mockResolvedValue(null);
  h.emitTargets.mockResolvedValue(runOf());
  h.endpoints.push({
    id: "w1", url: "https://hooks.example.test/w1", events: ["emission.completed"], secret: "s".repeat(64), active: true, createdBy: null,
    tenantId: T, createdAt: new Date(), updatedAt: new Date(),
  });
  webhookReceiver.postWebhook.mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...SAVED };
});

describe("POST /schemas/:id/emit: the emission notification", () => {
  it("answers first; the owner's notification and the emission.completed delivery are scheduled for after the answer", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);

    const response = await emitSchema(post("/schemas/order/emit"), withId("order"));

    expect(response.status).toBe(200);
    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
    expect(h.scheduled).toHaveLength(1);

    await runScheduled();

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({ userId: "owner-1", type: "CHANGE_COMPLETE" });
    expect(h.notifications[0].title).toBe("Order v1 emitted to 2 targets");
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({ endpointId: "w1", event: "emission.completed", statusCode: 200 });
    expect(h.deliveries[0].payload).toMatchObject({ event: "emission.completed", data: { tenantId: T, entityId: "order", entityName: "Order", version: "1", targetCount: 2, run: "preview" } });
  });

  it("an endpoint of another tenant hears nothing of this tenant's emission", async () => {
    h.endpoints.push({
      id: "w-other", url: "https://other.example.test/w", events: ["emission.completed"], secret: "s".repeat(64), active: true, createdBy: null,
      tenantId: "t-other", createdAt: new Date(), updatedAt: new Date(),
    });
    signIn([assign.domain("AUTHOR", T, "d-sales")]);

    await emitSchema(post("/schemas/order/emit"), withId("order"));
    await runScheduled();

    expect(h.deliveries.map((delivery) => delivery.endpointId)).toEqual(["w1"]);
    expect(webhookReceiver.postWebhook.mock.calls.map(([url]) => url)).toEqual(["https://hooks.example.test/w1"]);
  });

  it("an answer that cannot be built (the TypeSpec build throws) is a 500, and that run is not recorded as an emission", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    vi.mocked(generateTypeSpec).mockImplementationOnce(() => {
      throw new Error("TypeSpec build failed");
    });

    const response = await emitSchema(post("/schemas/order/emit"), withId("order"));

    expect(response.status).toBe(500);
    expect(h.scheduled).toHaveLength(0);
    await runScheduled();
    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });

  it("the answer is the same whether or not anybody is told: the body carries the targets of the run", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);

    const body = await bodyOf(await emitSchema(post("/schemas/order/emit"), withId("order")));

    expect(body.data.targets.map((target: { target: string }) => target.target)).toEqual(TARGETS);
    await runScheduled();
    expect(body.success).toBe(true);
  });

  it("a run refused for a reference the caller may not read schedules nothing", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    h.emitTargets.mockResolvedValue({
      results: [],
      refusal: { code: "REFERENCE_NOT_READABLE", message: 'The field "customerRef" refers to an entity you may not read', details: { field: "customerRef" } },
    });

    const response = await emitSchema(post("/schemas/order/emit"), withId("order"));

    expect(response.status).toBe(403);
    expect(h.scheduled).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });

  it("a run with an invalid target did not complete: nothing is scheduled", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    h.emitTargets.mockResolvedValue(runOf("INVALID"));

    const response = await emitSchema(post("/schemas/order/emit"), withId("order"));

    expect(response.status).toBe(200);
    expect(h.scheduled).toHaveLength(0);
  });

  it("an owner who no longer holds a role on the entity hears nothing, and the endpoints still get the event", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")], []);

    await emitSchema(post("/schemas/order/emit"), withId("order"));
    await runScheduled();

    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(1);
  });

  it("a service principal (the API key, no user row) emits, and the owner is told, not the key", async () => {
    process.env.API_KEY = KEY;
    process.env.API_KEY_TENANT_ID = T;
    h.users["owner-1"] = userRow([assign.domain("AUTHOR", T, "d-sales")], { id: "owner-1", email: "owner@example.test" });

    const response = await emitSchema(post("/schemas/order/emit", { headers: { authorization: `Bearer ${KEY}` } }), withId("order"));
    expect(response.status).toBe(200);
    await runScheduled();

    expect(h.notifications.map((row) => row.userId)).toEqual(["owner-1"]);
    expect(h.deliveries).toHaveLength(1);
  });

  it("a failing notification never changes the answer: the failure is logged, the answer is the same", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    h.prisma.webhookEndpoint.findMany.mockRejectedValue(new Error("DB connection failed"));

    const response = await emitSchema(post("/schemas/order/emit"), withId("order"));
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { entityId: "order", entityName: "Order" } });
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("a notification the database refuses to store does not stop the webhook event", async () => {
    signIn([assign.domain("AUTHOR", T, "d-sales")]);
    h.prisma.notification.create.mockRejectedValue(new Error("Simulated failure"));

    await emitSchema(post("/schemas/order/emit"), withId("order"));
    await runScheduled();

    expect(h.deliveries).toHaveLength(1);
  });
});
