import { beforeEach, describe, expect, it, vi } from "vitest";

// "Import OpenAPI" on the entity API tab: the preview (parse / fetch, nothing written) and the import (re-validated, duplicates
// skipped, one transaction), both guarded like the other operation actions (`asset.write`, active tenant; foreign reads like missing).

const { mockPrisma, mockAuth, mockGetActiveTenantId, mockRevalidate, mockFetchText } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  const delegate = () => ({
    findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
  });
  return {
    mockAuth: vi.fn(),
    mockGetActiveTenantId: vi.fn(),
    mockRevalidate: vi.fn(),
    mockFetchText: vi.fn(),
    mockPrisma: {
      ...emptyRegistryDelegates(),
      user: { findUnique: vi.fn() },
      tenant: delegate(), domain: delegate(), product: delegate(), entity: delegate(),
      serviceDefinition: delegate(), operation: delegate(),
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
vi.mock("@/lib/org-defaults", () => ({ ensureDefaultProductId: vi.fn().mockResolvedValue("p-own") }));
vi.mock("@/lib/api-operations/import-openapi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-operations/import-openapi")>()),
  fetchOpenApiText: mockFetchText,
}));

import { importOpenApiOperationsAction, previewOpenApiOperationsAction } from "@/app/(dashboard)/schemas/[domainSlug]/api-import-actions";

const T = "tenant-1";
const OTHER = "tenant-2";
type Mock = ReturnType<typeof vi.fn>;
const mk = (fn: unknown) => fn as Mock;

const DOC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Orders", version: "1" },
  paths: {
    "/orders": { get: { operationId: "listOrders", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } } } },
  },
  components: { schemas: { Order: { type: "object" } } },
});

const OP = (over: Record<string, unknown> = {}) => ({
  name: "getOrder", httpMethod: "GET", httpPath: "/orders/{id}",
  parameters: [{ name: "id", type: "uuid", location: "path", required: true }],
  responses: [{ statusCode: 200, type: "Order" }],
  ...over,
});

/** The row prisma.operation.create returns for a create call (the include echoes the nested creates). */
function rowOf(args: { data: Record<string, unknown> & { parameters: { create: unknown[] }; responses: { create: unknown[] } } }, id: string) {
  return { id, ...args.data, parameters: args.data.parameters.create, responses: args.data.responses.create };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "u@example.test" } });
  mockGetActiveTenantId.mockResolvedValue(T);
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  mockPrisma.product.findUnique.mockResolvedValue({ id: "p-own", domainId: "d-own", domain: { tenantId: T } });
  mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "p-own", tenantId: T });
  mockPrisma.serviceDefinition.findUnique.mockResolvedValue({ tenantId: T });
  mockPrisma.operation.findMany.mockResolvedValue([]);
  let n = 0;
  mockPrisma.operation.create.mockImplementation(async (args: Parameters<typeof rowOf>[0]) => rowOf(args, `op-${++n}`));
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(mockPrisma)));
});

describe("previewOpenApiOperationsAction", () => {
  it("maps pasted text for an entity of the active tenant", async () => {
    const result = await previewOpenApiOperationsAction("ent-1", { kind: "text", content: DOC });
    expect(result).toMatchObject({ success: true, data: { operations: [{ name: "listOrders", responses: [{ type: "Order", isArray: true }] }], referencedTypes: ["Order"] } });
    expect(mockPrisma.operation.create).not.toHaveBeenCalled();
  });

  it("answers an entity of another tenant exactly like a missing one, before parsing or fetching", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "p-own", tenantId: OTHER });
    const foreign = await previewOpenApiOperationsAction("ent-1", { kind: "url", url: "https://example.com/a.yaml" });
    mockPrisma.entity.findUnique.mockResolvedValue(null);
    const missing = await previewOpenApiOperationsAction("ent-1", { kind: "url", url: "https://example.com/a.yaml" });
    expect(foreign).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockFetchText).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect(await previewOpenApiOperationsAction("ent-1", { kind: "text", content: DOC })).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  it("fetches a URL through the guarded fetch, then maps it", async () => {
    mockFetchText.mockResolvedValue({ success: true, data: DOC });
    const result = await previewOpenApiOperationsAction("ent-1", { kind: "url", url: "https://example.com/openapi.json" });
    expect(mockFetchText).toHaveBeenCalledWith("https://example.com/openapi.json");
    expect(result).toMatchObject({ success: true, data: { operations: [{ name: "listOrders" }] } });
  });

  it("passes the fetch refusal through", async () => {
    mockFetchText.mockResolvedValue({ success: false, error: { code: "FETCH_ERROR", message: "The OpenAPI document could not be loaded: only https" } });
    expect(await previewOpenApiOperationsAction("ent-1", { kind: "url", url: "http://x" })).toMatchObject({ success: false, error: { code: "FETCH_ERROR" } });
  });

  it("rejects a malformed source", async () => {
    expect(await previewOpenApiOperationsAction("ent-1", { kind: "nope" } as never)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("importOpenApiOperationsAction", () => {
  const input = (operations: unknown[], serviceId: string | null = "svc-1") => ({ serviceId, domainId: "d-own", entityId: "ent-1", entityName: "Order", operations });

  it("creates every operation in ONE transaction and returns the records", async () => {
    const result = await importOpenApiOperationsAction(input([OP(), OP({ name: "listOrders", httpPath: "/orders", parameters: [], responses: [{ statusCode: 200, type: "Order", isArray: true }] })]));
    expect(result).toMatchObject({ success: true, serviceId: "svc-1", warnings: [] });
    if (!result.success) return;
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(result.created.map((r) => [r.id, r.serviceId, r.name, r.httpPath])).toEqual([
      ["op-1", "svc-1", "getOrder", "/orders/{id}"],
      ["op-2", "svc-1", "listOrders", "/orders"],
    ]);
    expect(result.created[0].parameters).toEqual([{ name: "id", type: "uuid", isArray: false, location: "path", required: true, description: "" }]);
    expect(mockRevalidate).toHaveBeenCalled();
  });

  it("skips what the service already has (same method + path template) and renames a clashing name", async () => {
    mockPrisma.operation.findMany.mockResolvedValue([
      { id: "op-x", serviceId: "svc-1", name: "readOrder", description: "", httpMethod: "GET", httpPath: "/orders/{orderId}", parameters: [{ name: "orderId", type: "uuid", location: "path", required: true, description: "" }], responses: [] },
      { id: "op-y", serviceId: "svc-1", name: "deleteOrder", description: "", httpMethod: "DELETE", httpPath: "/legacy/{id}", parameters: [{ name: "id", type: "uuid", location: "path", required: true, description: "" }], responses: [] },
    ]);
    const result = await importOpenApiOperationsAction(
      input([
        OP(),
        OP({ name: "deleteOrder", httpMethod: "DELETE", httpPath: "/orders/{orderId}", parameters: [{ name: "orderId", type: "uuid", location: "path" }], responses: [{ statusCode: 204 }] }),
      ])
    );
    expect(result).toMatchObject({ success: true });
    if (!result.success) return;
    expect(result.created.map((r) => r.name)).toEqual(["deleteOrder_2"]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/GET \/orders\/\{id\} already exists \("readOrder"\); skipped/),
      expect.stringMatching(/"deleteOrder" is already used .* imported as "deleteOrder_2"/),
    ]);
  });

  it("skips duplicates inside the payload itself", async () => {
    const result = await importOpenApiOperationsAction(input([OP(), OP({ name: "getOrder2" })]));
    expect(result).toMatchObject({ success: true, warnings: [expect.stringMatching(/already exists \("getOrder"\)/)] });
    if (result.success) expect(result.created).toHaveLength(1);
  });

  it("re-validates every operation (the payload comes from the browser): an invalid one is reported, the rest imported", async () => {
    const result = await importOpenApiOperationsAction(input([OP(), OP({ name: "bad name", httpPath: "/x" })]));
    expect(result).toMatchObject({ success: true, warnings: [expect.stringMatching(/was not imported: name .*identifier/)] });
    if (result.success) expect(result.created.map((r) => r.name)).toEqual(["getOrder"]);
  });

  it("imports an OPTIONS operation and reports its save-time warning (it is not generated)", async () => {
    const result = await importOpenApiOperationsAction(input([OP(), OP({ name: "optionsOrder", httpMethod: "OPTIONS" })]));
    expect(result).toMatchObject({ success: true, warnings: [expect.stringMatching(/^OPTIONS \/orders\/\{id\}: OPTIONS operations are stored but left out/)] });
    if (result.success) expect(result.created.map((r) => r.httpMethod)).toEqual(["GET", "OPTIONS"]);
  });

  it("refuses an empty, oversized or wholly invalid payload before any query", async () => {
    expect(await importOpenApiOperationsAction(input([]))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await importOpenApiOperationsAction(input(Array(501).fill(OP())))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await importOpenApiOperationsAction(input([{ name: "x" }]))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockPrisma.serviceDefinition.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers a service of another tenant like a missing one; nothing is written", async () => {
    mockPrisma.serviceDefinition.findUnique.mockResolvedValue({ tenantId: OTHER });
    const foreign = await importOpenApiOperationsAction(input([OP()]));
    mockPrisma.serviceDefinition.findUnique.mockResolvedValue(null);
    const missing = await importOpenApiOperationsAction(input([OP()]));
    expect(foreign).toEqual({ error: "API service not found", code: "NOT_FOUND" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates the entity's API service first when there is none", async () => {
    mockPrisma.serviceDefinition.findFirst.mockResolvedValue({ id: "svc-existing" });
    const result = await importOpenApiOperationsAction(input([OP()], null));
    expect(result).toMatchObject({ success: true, serviceId: "svc-existing" });
    expect(mk(mockPrisma.operation.create).mock.calls[0][0].data.serviceId).toBe("svc-existing");
  });

  it("refuses when the entity is not reachable (no service created)", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(null);
    expect(await importOpenApiOperationsAction(input([OP()], null))).toMatchObject({ error: "Entity not found" });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("an unexpected throw is the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.$transaction.mockRejectedValue(new Error("Invalid `prisma.operation.create()` invocation"));
    const result = await importOpenApiOperationsAction(input([OP()]));
    expect(result).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/prisma/);
    spy.mockRestore();
  });
});
