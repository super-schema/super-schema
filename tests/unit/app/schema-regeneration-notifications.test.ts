// @vitest-environment node
/**
 * Which schema generations are emissions. A UI generation (`generateSchemaAction`) is one: its owner and the endpoints of `emission.completed`
 * hear of it, after the answer. A field-type override save regenerates the schema as a step of its own write, and a publish regenerates from the
 * published versions; neither is an emission, so neither schedules a notification nor dispatches an event. Through the real actions; Prisma, the
 * emitters, the session and the webhook receiver are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, resetSessionPrincipal, userRow } from "../../helpers/access-mocks";

const h = vi.hoisted(() => ({
  scheduled: [] as Array<() => Promise<unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  deliveries: [] as Array<Record<string, unknown>>,
  endpoints: [] as Array<Record<string, unknown>>,
  prisma: {
    entity: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    field: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    typeMappingOverride: { findMany: vi.fn() },
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
vi.mock("@/lib/db", () => ({ prisma: h.prisma }));

// Which targets APPLY a stored per-field type override (`supportsFieldOverrides`): none does in the catalog, so this test says that bigquery does.
const offering = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/schema-targets/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/schema-targets/catalog")>();
  return {
    ...actual,
    getSchemaTargetDefinition: (key: string) => {
      const definition = actual.getSchemaTargetDefinition(key);
      return definition && offering.has(key) ? { ...definition, supportsFieldOverrides: true } : definition;
    },
  };
});

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn().mockResolvedValue("tenant-1") }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Inside a request `after` keeps the task for once the answer is sent; the tests run what was kept.
  after: (task: () => Promise<unknown>) => {
    h.scheduled.push(task);
  },
}));
vi.mock("@/lib/typespec-official/emitter.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/emitter.service")>()),
  emitOfficialTypeSpecTargetForEntity: vi.fn(async () => ({ output: "CREATE TABLE t (id STRING);", validationStatus: "VALID", warnings: [], errors: [] })),
}));
vi.mock("@/lib/typespec-official/closure-emit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/typespec-official/closure-emit")>()),
  emitClosure: vi.fn(),
}));

import * as actions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const p = h.prisma;
const TENANT = "tenant-1";

/** The one entity of these tests: `ent-1`, owned by `owner-1`, with a decimal key `amount` (precision 10, scale 2). */
const amount = {
  id: "field-amount", name: "amount", type: "decimal", precision: 10, scale: 2, nullable: false, isKey: true, fieldNumber: null,
  description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
};
const entityRow = () => ({
  id: "ent-1", tenantId: TENANT, name: "TestEntity", version: 1, ownerId: "owner-1", metadata: {}, status: "DRAFT", latestVersionId: null,
  domain: null, product: null, domainId: null, productId: null, fields: [amount], createdAt: new Date(), updatedAt: new Date(),
});

const runScheduled = async () => {
  for (const task of h.scheduled.splice(0)) await task();
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  h.scheduled.splice(0);
  h.notifications.splice(0);
  h.deliveries.splice(0);
  h.endpoints.splice(0);
  offering.clear();
  offering.add("bigquery");
  h.endpoints.push({ id: "w1", url: "https://hooks.example.test/w1", events: ["emission.completed"], secret: "s".repeat(64), active: true, createdBy: null });

  p.entity.findUnique.mockImplementation(async () => entityRow());
  p.entity.findMany.mockResolvedValue([]);
  p.entity.update.mockResolvedValue({ id: "ent-1" });
  p.field.findMany.mockResolvedValue([amount]);
  p.field.findUnique.mockResolvedValue(amount);
  p.field.update.mockResolvedValue({ id: "field-amount" });
  p.auditLog.create.mockResolvedValue({ id: "audit-1" });
  p.typeMappingOverride.findMany.mockResolvedValue([]);
  p.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "owner-1" ? userRow([assign.tenant("AUTHOR", TENANT)], { id: "owner-1", email: "owner@example.test" }) : { id: where.id }
  );
  p.notification.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `n-${h.notifications.length + 1}`, read: false, createdAt: new Date(), ...data };
    h.notifications.push(row);
    return row;
  });
  p.webhookEndpoint.findMany.mockImplementation(async ({ where }: { where: { events: { hasSome: string[] } } }) =>
    h.endpoints.filter((endpoint) => (endpoint.events as string[]).some((event) => where.events.hasSome.includes(event)))
  );
  p.webhookDelivery.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: `d-${h.deliveries.length + 1}`, nextRetryAt: null, deliveredAt: new Date(), attempt: 1, error: null, ...data };
    h.deliveries.push(row);
    return row;
  });
  p.webhookDelivery.findMany.mockResolvedValue([]);
  p.webhookDelivery.update.mockResolvedValue(null);
  webhookReceiver.postWebhook.mockResolvedValue(new Response(null, { status: 200 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a field-type override save is not an emission", () => {
  it("saves and regenerates, and schedules and dispatches nothing", async () => {
    const result = await actions.saveSchemaFieldTypeOverrideAction({ entityId: "ent-1", target: "bigquery", fieldId: "field-amount", mappedType: "NUMERIC(10,2)" });

    expect(result).toMatchObject({ success: true });
    expect(p.entity.update).toHaveBeenCalled(); // the regeneration stored a version
    expect(h.scheduled).toHaveLength(0);
    await runScheduled();
    expect(h.notifications).toHaveLength(0);
    expect(h.deliveries).toHaveLength(0);
  });
});

describe("a UI generation is an emission", () => {
  it("schedules exactly one emission notification, after the answer, and the endpoints are told once", async () => {
    const result = await actions.generateSchemaAction("ent-1", "bigquery");

    expect(result).toMatchObject({ success: true });
    expect(h.scheduled).toHaveLength(1);
    await runScheduled();
    expect(h.notifications).toEqual([expect.objectContaining({ userId: "owner-1", type: "CHANGE_COMPLETE", title: "TestEntity v1 emitted to 1 target" })]);
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0].payload).toMatchObject({ event: "emission.completed", data: { run: "stored", targetCount: 1, entityId: "ent-1" } });
  });
});
