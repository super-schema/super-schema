import { beforeEach, describe, expect, it, vi } from "vitest";

// Tenant scoping + generic failures of the older by-id actions in schemas/[domainSlug]/actions.ts that F2 left unguarded:
// model fields, entity / data-type / API / operation deletes, operation creates and the live operation save, entity and API
// creates (the parent id), the bulk import's domain. Every guard is checked three ways: the row of ANOTHER tenant gets the
// byte-identical answer of a MISSING row and NOTHING reaches a prisma write; the caller's own row still works; an unexpected
// throw (a Prisma-like error carrying an absolute path and a source excerpt) reaches the browser as the generic message only.

const { mockPrisma, mockAuth, mockGetActiveTenantId, mockRevalidate } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  const delegate = () => ({
    findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
  });
  return {
    mockAuth: vi.fn(),
    mockGetActiveTenantId: vi.fn(),
    mockRevalidate: vi.fn(),
    mockPrisma: {
      ...emptyRegistryDelegates(),
      user: { findUnique: vi.fn() },
      tenant: delegate(), domain: delegate(), product: delegate(), entity: delegate(),
      modelDefinition: delegate(), modelFieldDefinition: delegate(),
      sharedEnum: delegate(), customScalar: delegate(), unionType: delegate(),
      serviceDefinition: delegate(), operation: delegate(),
      operationParameter: { deleteMany: vi.fn() }, operationResponse: { deleteMany: vi.fn() },
      entityVersion: { findMany: vi.fn().mockResolvedValue([]) }, schemaReference: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn() },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));

import {
  addModelFieldAction,
  createDomainAssetsFromImportAction,
  createEntityAction,
  createEntityWithFieldsAction,
  createOperationAction,
  createServiceAction,
  deleteCustomScalarAction,
  deleteEntityAction,
  deleteModelFieldAction,
  deleteOperationAction,
  deleteServiceAction,
  deleteSharedEnumAction,
  deleteUnionTypeAction,
  getOrCreateEntityServiceAction,
  replaceOperationDetailsAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const T = "tenant-1";
const OTHER = "tenant-2";
const asAny = (v: unknown) => v as never;

/** A Prisma validation error as the driver writes it: absolute path, source excerpt, argument names. */
const PRISMA_TEXT =
  "Invalid `prisma.operation.create()` invocation in\n/Users/dev/src/my/super-schema/src/app/(dashboard)/schemas/[domainSlug]/actions.ts:759:42\n\n" +
  "  756 try {\n→ 759 const created = await prisma.operation.create({ data: { serviceId: undefined\nArgument `service` is missing.";
const LEAKS = /prisma|Users\/dev|actions\.ts|invocation|Argument|undefined|Cannot read properties|TypeError/i;

type Mock = ReturnType<typeof vi.fn>;
const mk = (fn: unknown) => fn as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "user-1", email: "u@example.test" } });
  mockGetActiveTenantId.mockResolvedValue(T);
  mockPrisma.user.findUnique.mockResolvedValue({ id: "user-1" });
  mockPrisma.auditLog.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: typeof mockPrisma) => unknown)(mockPrisma)
  );
  mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  // domain d-own / d-foreign / anything else is missing; product p-own likewise
  mockPrisma.domain.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "d-own" ? { id: "d-own", tenantId: T } : where.id === "d-foreign" ? { id: "d-foreign", tenantId: OTHER } : null
  );
  mockPrisma.product.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "p-own" ? { id: "p-own", domainId: "d-own", domain: { tenantId: T } } : null
  );
  for (const key of ["modelFieldDefinition", "sharedEnum", "customScalar", "unionType", "serviceDefinition", "operation", "modelDefinition", "entity"] as const) {
    mockPrisma[key].delete.mockResolvedValue({ id: "row-1" });
    mockPrisma[key].create.mockResolvedValue({ id: "row-new" });
    mockPrisma[key].update.mockResolvedValue({ id: "row-1" });
  }
  mockPrisma.operation.create.mockResolvedValue({ id: "op-new" });
  mockPrisma.serviceDefinition.create.mockResolvedValue({ id: "svc-new" });
  mockPrisma.operationParameter.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.operationResponse.deleteMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// Table: every by-id action with ONE row lookup and one write
// ---------------------------------------------------------------------------

interface GuardedCase {
  label: string;
  /** What the not-found answer calls the row. */
  kind: string;
  call: () => Promise<unknown>;
  /** The lookup that places the row (or its parent) in a tenant. */
  lookup: () => Mock;
  /** The row as that lookup returns it for tenant `t`. */
  row: (t: string) => unknown;
  /** Every prisma write the action can reach: none may be called for a foreign or missing row. */
  writes: () => Mock[];
  /** The write the legit path must reach. */
  mainWrite: () => Mock;
  /** A malformed id the action must reject before any query (`null` when the action has no id validation). */
  badCall: (() => Promise<unknown>) | null;
}

const OP_DETAILS = {
  name: "getOrder", httpMethod: "GET", httpPath: "/orders/{id}", description: "d",
  parameters: [{ name: "id", type: "string", location: "path", required: true, description: "" }],
  responses: [{ statusCode: 200, type: "Order", description: "ok" }],
};

const CASES: GuardedCase[] = [
  {
    label: "deleteModelFieldAction", kind: "Field", call: () => deleteModelFieldAction("mf-1"),
    lookup: () => mk(mockPrisma.modelFieldDefinition.findUnique), row: (t) => ({ model: { domain: { tenantId: t } } }),
    writes: () => [mk(mockPrisma.modelFieldDefinition.delete)], mainWrite: () => mk(mockPrisma.modelFieldDefinition.delete),
    badCall: () => deleteModelFieldAction(asAny(undefined)),
  },
  {
    label: "deleteSharedEnumAction", kind: "Enum", call: () => deleteSharedEnumAction("e-1"),
    lookup: () => mk(mockPrisma.sharedEnum.findUnique), row: (t) => ({ tenantId: t }),
    writes: () => [mk(mockPrisma.sharedEnum.delete)], mainWrite: () => mk(mockPrisma.sharedEnum.delete),
    badCall: () => deleteSharedEnumAction(asAny("  ")),
  },
  {
    label: "deleteCustomScalarAction", kind: "Scalar", call: () => deleteCustomScalarAction("sc-1"),
    lookup: () => mk(mockPrisma.customScalar.findUnique), row: (t) => ({ tenantId: t }),
    writes: () => [mk(mockPrisma.customScalar.delete)], mainWrite: () => mk(mockPrisma.customScalar.delete),
    badCall: () => deleteCustomScalarAction(asAny(5)),
  },
  {
    label: "deleteUnionTypeAction", kind: "Union", call: () => deleteUnionTypeAction("u-1"),
    lookup: () => mk(mockPrisma.unionType.findUnique), row: (t) => ({ tenantId: t }),
    writes: () => [mk(mockPrisma.unionType.delete)], mainWrite: () => mk(mockPrisma.unionType.delete),
    badCall: () => deleteUnionTypeAction(asAny({})),
  },
  {
    label: "deleteServiceAction", kind: "API service", call: () => deleteServiceAction("svc-1"),
    lookup: () => mk(mockPrisma.serviceDefinition.findUnique), row: (t) => ({ tenantId: t }),
    writes: () => [mk(mockPrisma.serviceDefinition.delete)], mainWrite: () => mk(mockPrisma.serviceDefinition.delete),
    badCall: () => deleteServiceAction(asAny(null)),
  },
  {
    label: "deleteOperationAction", kind: "Operation", call: () => deleteOperationAction("op-1"),
    lookup: () => mk(mockPrisma.operation.findUnique), row: (t) => ({ service: { tenantId: t } }),
    writes: () => [mk(mockPrisma.operation.delete)], mainWrite: () => mk(mockPrisma.operation.delete),
    badCall: () => deleteOperationAction(asAny("")),
  },
  {
    label: "createOperationAction (guards its PARENT API)", kind: "API service", call: () => createOperationAction("svc-1", { name: "getOrder", httpMethod: "GET", httpPath: "/o" }),
    lookup: () => mk(mockPrisma.serviceDefinition.findUnique), row: (t) => ({ tenantId: t }),
    writes: () => [mk(mockPrisma.operation.create)], mainWrite: () => mk(mockPrisma.operation.create),
    badCall: () => createOperationAction(asAny(undefined), { name: "getOrder", httpMethod: "GET", httpPath: "/o" }),
  },
  {
    label: "replaceOperationDetailsAction (the live operation save)", kind: "Operation", call: () => replaceOperationDetailsAction("op-1", asAny(OP_DETAILS)),
    lookup: () => mk(mockPrisma.operation.findUnique), row: (t) => ({ service: { tenantId: t } }),
    writes: () => [mk(mockPrisma.$transaction), mk(mockPrisma.operationParameter.deleteMany), mk(mockPrisma.operationResponse.deleteMany), mk(mockPrisma.operation.update)],
    mainWrite: () => mk(mockPrisma.operation.update),
    badCall: () => replaceOperationDetailsAction(asAny(undefined), asAny(OP_DETAILS)),
  },
  {
    label: "addModelFieldAction (guards its PARENT model)", kind: "Model", call: () => addModelFieldAction("m-1", { name: "email", type: "string" }),
    lookup: () => mk(mockPrisma.modelDefinition.findUnique), row: (t) => ({ domain: { tenantId: t }, _count: { fields: 2 } }),
    writes: () => [mk(mockPrisma.modelFieldDefinition.create)], mainWrite: () => mk(mockPrisma.modelFieldDefinition.create),
    badCall: () => addModelFieldAction(asAny(""), { name: "email", type: "string" }),
  },
];

describe.each(CASES)("$label", (c) => {
  it("works on a row of the active tenant", async () => {
    c.lookup().mockResolvedValue(c.row(T));
    expect(await c.call()).toMatchObject({ success: true });
    expect(c.mainWrite()).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).toHaveBeenCalledWith("/schemas");
  });

  it("answers NOT_FOUND for a row of ANOTHER tenant and nothing reaches a prisma write", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    const result = await c.call();
    expect(result).toEqual({ error: `${c.kind} not found`, code: "NOT_FOUND" });
    for (const write of c.writes()) expect(write).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("answers a MISSING row byte-identically (no existence oracle across tenants)", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    const foreign = await c.call();
    c.lookup().mockResolvedValue(null);
    const missing = await c.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    for (const write of c.writes()) expect(write).not.toHaveBeenCalled();
  });

  it("follows the ACTIVE tenant: the row is foreign today and the caller's after a tenant switch", async () => {
    c.lookup().mockResolvedValue(c.row(OTHER));
    expect(await c.call()).toMatchObject({ code: "NOT_FOUND" });
    mockGetActiveTenantId.mockResolvedValue(OTHER);
    expect(await c.call()).toMatchObject({ success: true });
  });

  it("requires a session before any query", async () => {
    mockAuth.mockResolvedValue(null);
    expect(await c.call()).toEqual({ error: "Not authenticated" });
    expect(c.lookup()).not.toHaveBeenCalled();
    for (const write of c.writes()) expect(write).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with VALIDATION_ERROR before any query", async () => {
    const result = (await c.badCall!()) as { code?: string; error?: string };
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(c.lookup()).not.toHaveBeenCalled();
    for (const write of c.writes()) expect(write).not.toHaveBeenCalled();
  });

  it("returns the generic message (and logs the original) when the write throws a Prisma error with a path and a source excerpt", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    c.lookup().mockResolvedValue(c.row(T));
    // The write itself, or (for the batch) its first statement, rejects with driver text.
    for (const write of c.writes()) write.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await c.call();
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    expect(spy).toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns the generic message when the ownership lookup itself throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    c.lookup().mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await c.call();
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    for (const write of c.writes()) expect(write).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// replaceOperationDetailsAction / createOperationAction: input validation (no TypeError text)
// ---------------------------------------------------------------------------

describe("replaceOperationDetailsAction input validation", () => {
  const replace = (data: unknown) => replaceOperationDetailsAction("op-1", asAny(data));
  beforeEach(() => mk(mockPrisma.operation.findUnique).mockResolvedValue({ service: { tenantId: T } }));

  it("rejects a payload with `parameters` (or `responses`) missing with VALIDATION_ERROR, not 'Cannot read properties of undefined'", async () => {
    const noParams: Record<string, unknown> = { ...OP_DETAILS };
    delete noParams.parameters;
    const noResponses: Record<string, unknown> = { ...OP_DETAILS };
    delete noResponses.responses;
    for (const data of [noParams, noResponses, { ...OP_DETAILS, parameters: undefined }, { ...OP_DETAILS, responses: null }]) {
      const result = (await replace(data)) as { error: string; code: string };
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.error).toMatch(/parameters|responses/);
      expect(result.error).not.toMatch(LEAKS);
    }
    expect(mockPrisma.operation.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-object payload", null], ["a string payload", "x"], ["an array payload", [OP_DETAILS]],
    ["a non-string name", { ...OP_DETAILS, name: 5 }], ["a blank name", { ...OP_DETAILS, name: "   " }],
    ["a non-string method", { ...OP_DETAILS, httpMethod: 1 }], ["a non-string path", { ...OP_DETAILS, httpPath: null }],
    ["a non-string description", { ...OP_DETAILS, description: {} }],
    ["parameters that are not a list", { ...OP_DETAILS, parameters: "id" }],
    ["a parameter that is not an object", { ...OP_DETAILS, parameters: ["id"] }],
    ["a parameter with a missing name", { ...OP_DETAILS, parameters: [{ type: "string", location: "path", required: true }] }],
    ["a parameter whose `required` is not a boolean", { ...OP_DETAILS, parameters: [{ name: "id", type: "string", location: "path", required: "yes" }] }],
    ["a response whose status code is not an integer", { ...OP_DETAILS, responses: [{ statusCode: "200", type: null, description: "" }] }],
    ["a response whose type is a number", { ...OP_DETAILS, responses: [{ statusCode: 200, type: 5, description: "" }] }],
  ])("rejects %s with VALIDATION_ERROR before any query or write", async (_label, data) => {
    const result = (await replace(data)) as { error: string; code: string };
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).not.toMatch(LEAKS);
    expect(mockPrisma.operation.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("saves the trimmed name, defaults the optional columns and writes the complete lists in ONE batch (delete params, delete responses, update)", async () => {
    const result = await replace({
      name: "  getOrder  ", httpMethod: "GET", httpPath: "/o",
      parameters: [{ name: "id", type: "string", location: "path", required: true, extra: "ignored" }],
      responses: [{ statusCode: 200, type: undefined, description: undefined }, { statusCode: 404, type: null }],
    });
    expect(result).toEqual({ success: true });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(3);
    expect(mockPrisma.operationParameter.deleteMany).toHaveBeenCalledWith({ where: { operationId: "op-1" } });
    expect(mockPrisma.operationResponse.deleteMany).toHaveBeenCalledWith({ where: { operationId: "op-1" } });
    expect(mockPrisma.operation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: {
        name: "getOrder", httpMethod: "GET", httpPath: "/o", description: "",
        parameters: { create: [{ name: "id", type: "string", location: "path", required: true, description: "" }] },
        responses: { create: [{ statusCode: 200, type: null, description: "" }, { statusCode: 404, type: null, description: "" }] },
      },
    });
  });
});

describe("createOperationAction input validation", () => {
  const create = (data: unknown) => createOperationAction("svc-1", asAny(data));
  beforeEach(() => mk(mockPrisma.serviceDefinition.findUnique).mockResolvedValue({ tenantId: T }));

  it("creates with a trimmed name; `parameters` / `responses` are optional here (the domain API tab sends none)", async () => {
    expect(await create({ name: "  listOrders ", httpMethod: "GET", httpPath: "/" })).toEqual({ success: true, operationId: "op-new" });
    expect(mockPrisma.operation.create).toHaveBeenCalledWith({
      data: {
        serviceId: "svc-1", name: "listOrders", httpMethod: "GET", httpPath: "/", description: "",
        parameters: { create: [] }, responses: { create: [] },
      },
    });
  });

  it.each([
    ["a non-object payload", undefined], ["a blank name", { name: " ", httpMethod: "GET", httpPath: "/" }],
    ["a missing method", { name: "x", httpPath: "/" }], ["malformed parameters", { name: "x", httpMethod: "GET", httpPath: "/", parameters: [1] }],
    ["malformed responses", { name: "x", httpMethod: "GET", httpPath: "/", responses: "ok" }],
  ])("rejects %s with VALIDATION_ERROR before any query", async (_label, data) => {
    const result = (await create(data)) as { code: string; error: string };
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).not.toMatch(LEAKS);
    expect(mockPrisma.serviceDefinition.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.operation.create).not.toHaveBeenCalled();
  });
});

describe("addModelFieldAction names and input", () => {
  const add = (data: unknown) => addModelFieldAction("m-1", asAny(data));
  beforeEach(() => mk(mockPrisma.modelDefinition.findUnique).mockResolvedValue({ domain: { tenantId: T }, _count: { fields: 3 } }));

  it("stores the trimmed name, the defaults and sortOrder = the model's field count", async () => {
    expect(await add({ name: "  email  ", type: "string" })).toEqual({ success: true });
    expect(mockPrisma.modelFieldDefinition.create).toHaveBeenCalledWith({
      data: { modelId: "m-1", name: "email", type: "string", nullable: true, isKey: false, description: "", sortOrder: 3 },
    });
  });

  it.each([
    [{ name: "" }], [{ name: "   ", type: "string" }], [{ name: 5, type: "string" }], [{ name: "x" }], [{ name: "x", type: "string", nullable: "no" }],
    [null], ["x"], [[{ name: "x", type: "string" }]],
  ])("rejects %j with VALIDATION_ERROR before any query", async (data) => {
    expect(await add(data)).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mockPrisma.modelDefinition.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.modelFieldDefinition.create).not.toHaveBeenCalled();
  });

  it("reports a duplicate name as a conflict (never the Prisma text)", async () => {
    mockPrisma.modelFieldDefinition.create.mockRejectedValue(new Error("Unique constraint failed on the fields: (`modelId`,`name`)"));
    expect(await add({ name: "email", type: "string" })).toEqual({ error: 'Field "email" already exists', code: "NAME_CONFLICT" });
  });
});

// ---------------------------------------------------------------------------
// deleteEntityAction (F3's in-use logic stays; the tenant guard is new)
// ---------------------------------------------------------------------------

describe("deleteEntityAction tenant guard", () => {
  const entityRow = (tenantId: string) => ({ id: "ent-1", name: "Order", tenantId });

  it("deletes an entity of the active tenant", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(T));
    expect(await deleteEntityAction("ent-1")).toEqual({ success: true });
    expect(mockPrisma.entity.delete).toHaveBeenCalledWith({ where: { id: "ent-1" } });
  });

  it("answers an entity of ANOTHER tenant exactly like a missing one and deletes nothing (no audit row, no in-use read)", async () => {
    mockPrisma.entity.findUnique.mockResolvedValue(entityRow(OTHER));
    const foreign = await deleteEntityAction("ent-1");
    mockPrisma.entity.findUnique.mockResolvedValue(null);
    const missing = await deleteEntityAction("ent-1");
    expect(foreign).toEqual({ error: "Entity not found" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockPrisma.entity.delete).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    expect(mockPrisma.entityVersion.findMany).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Create-style actions guard the PARENT
// ---------------------------------------------------------------------------

describe("createEntityWithFieldsAction / createEntityAction guard the PARENT domain", () => {
  const details = { name: "Customer", description: "", fields: [] };
  const form = () => {
    const fd = new FormData();
    fd.set("name", "Customer");
    return fd;
  };

  const expectNothingCreated = () => {
    expect(mockPrisma.entity.create).not.toHaveBeenCalled();
    expect(mockPrisma.product.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  };

  it("createEntityWithFieldsAction: a foreign domain reads exactly like a missing one; nothing is created", async () => {
    const foreign = await createEntityWithFieldsAction("d-foreign", details);
    const missing = await createEntityWithFieldsAction("d-none", details);
    expect(foreign).toEqual({ error: "Domain not found", code: "NOT_FOUND" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expectNothingCreated();
  });

  it("createEntityAction: a foreign domain reads exactly like a missing one; nothing is created", async () => {
    const foreign = await createEntityAction("d-foreign", form());
    const missing = await createEntityAction("d-none", form());
    expect(foreign).toEqual({ error: "Domain not found", code: "NOT_FOUND" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expectNothingCreated();
  });

  it("createEntityAction: a payload that is not a FormData is a validation failure, not a TypeError", async () => {
    for (const bad of [null, undefined, {}, "x"]) {
      expect(await createEntityAction("d-own", asAny(bad))).toEqual({ error: "Entity name is required" });
    }
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("createEntityWithFieldsAction: malformed details are a validation failure, not a TypeError", async () => {
    for (const data of [null, undefined, "x", 5, [], { name: 5 }, { name: "   " }, { description: "no name" }]) {
      const result = (await createEntityWithFieldsAction("d-own", asAny(data))) as { error: string };
      expect(result.error).toMatch(/details are required|name is required/);
      expect(result.error).not.toMatch(LEAKS);
    }
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("createEntityWithFieldsAction: an unexpected throw is generic, never the driver text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.domain.findUnique.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await createEntityWithFieldsAction("d-own", details);
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("createServiceAction guards its target", () => {
  const data = { name: "OrdersApi", scope: "DOMAIN" as const };

  it("creates in a domain of the active tenant", async () => {
    expect(await createServiceAction("d-own", data)).toEqual({ success: true, serviceId: "svc-new" });
    expect(mockPrisma.serviceDefinition.create).toHaveBeenCalledTimes(1);
  });

  it("a DOMAIN target of another tenant reads exactly like a missing one; nothing is created", async () => {
    const foreign = await createServiceAction("d-foreign", data);
    const missing = await createServiceAction("d-none", { ...data });
    expect(foreign).toEqual({ error: 'Domain "d-foreign" not found' });
    expect(missing).toEqual({ error: 'Domain "d-none" not found' });
    expect(mockPrisma.serviceDefinition.create).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("an explicit PRODUCT target is checked the same way (a product of another tenant's domain is foreign)", async () => {
    mockPrisma.product.findUnique.mockResolvedValue({ id: "p-foreign", domainId: "d-foreign", domain: { tenantId: OTHER } });
    expect(await createServiceAction("d-own", data, { level: "PRODUCT", productId: "p-foreign" })).toEqual({ error: 'Product "p-foreign" not found' });
    expect(mockPrisma.serviceDefinition.create).not.toHaveBeenCalled();
  });

  it("an ENTITY-scoped API of a foreign entity reads exactly like a missing entity (and nothing is created)", async () => {
    const entityData = { name: "OrderApi", scope: "ENTITY" as const, entityId: "ent-1" };
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "p-own", tenantId: OTHER });
    const foreign = await createServiceAction("d-own", entityData);
    mockPrisma.entity.findUnique.mockResolvedValue(null);
    const missing = await createServiceAction("d-own", entityData);
    expect(foreign).toEqual({ error: "Entity not found" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockPrisma.serviceDefinition.create).not.toHaveBeenCalled();
  });

  it("never takes the tenant from the client: a TENANT target is the active tenant (an API cannot live there) and creates nothing", async () => {
    const result = (await createServiceAction("d-own", data, { level: "TENANT", tenantId: OTHER })) as { error?: string };
    expect(result.error).toBeDefined();
    expect(mockPrisma.serviceDefinition.create).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: T } }));
  });

  it.each([
    [null], ["x"], [{ name: 5, scope: "DOMAIN" }], [{ name: "  ", scope: "DOMAIN" }], [{ name: "x", scope: "TENANT" }], [{ name: "x" }],
    [{ name: "x", scope: "DOMAIN", basePath: 5 }],
  ])("rejects malformed details %j with VALIDATION_ERROR before any query", async (bad) => {
    const result = (await createServiceAction("d-own", asAny(bad))) as { code: string; error: string };
    expect(result.code).toBe("VALIDATION_ERROR");
    expect(result.error).not.toMatch(LEAKS);
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
  });

  it("an unexpected throw is the generic message, not the driver text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.serviceDefinition.create.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await createServiceAction("d-own", data);
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("getOrCreateEntityServiceAction", () => {
  it("answers a foreign entity like a missing one WITHOUT first reading its existing service (no service-id leak)", async () => {
    mockPrisma.serviceDefinition.findFirst.mockResolvedValue({ id: "svc-of-another-tenant" });
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "p-own", tenantId: OTHER });
    const foreign = await getOrCreateEntityServiceAction("d-own", "ent-1", "Order");
    mockPrisma.entity.findUnique.mockResolvedValue(null);
    const missing = await getOrCreateEntityServiceAction("d-own", "ent-1", "Order");
    expect(foreign).toEqual({ error: "Entity not found" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockPrisma.serviceDefinition.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.serviceDefinition.create).not.toHaveBeenCalled();
  });

  it("still returns the existing service of an entity of the active tenant", async () => {
    mockPrisma.serviceDefinition.findFirst.mockResolvedValue({ id: "svc-existing" });
    mockPrisma.entity.findUnique.mockResolvedValue({ id: "ent-1", productId: "p-own", tenantId: T });
    expect(await getOrCreateEntityServiceAction("d-own", "ent-1", "Order")).toEqual({ success: true, serviceId: "svc-existing" });
  });

  it("an unexpected throw is the generic message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.entity.findUnique.mockRejectedValue(new Error(PRISMA_TEXT));
    expect(await getOrCreateEntityServiceAction("d-own", "ent-1", "Order")).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("createDomainAssetsFromImportAction guards its domain", () => {
  const payload = (domainId: string) => ({
    domainId, models: [], entities: [{ name: "Customer", description: "", fields: [] }], sharedEnums: [], customScalars: [], unionTypes: [],
    services: [], decoratorDefinitions: [],
  });

  it("a domain of another tenant reads exactly like a missing one: nothing is imported, no transaction opens", async () => {
    const foreign = await createDomainAssetsFromImportAction(payload("d-foreign"));
    mockPrisma.domain.findUnique.mockResolvedValue(null);
    const missing = await createDomainAssetsFromImportAction(payload("d-foreign"));
    expect(foreign).toMatchObject({ entitiesCreated: 0, modelsCreated: 0, errors: ['Domain "d-foreign" not found'] });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
