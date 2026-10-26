import { beforeEach, describe, expect, it, vi } from "vitest";

// Probe-style tests for the older (non-Result) data-type / model-field / operation actions: mass-assignment whitelists,
// active-tenant ownership, malformed-input handling and trimmed names. The name registry is the REAL one, running against
// a fake database that compares names the way Postgres does (exact, case-insensitive; NOT trimmed).

const { mockPrisma, mockAuth, mockGetActiveTenantId, mockRevalidate } = await vi.hoisted(async () => {
  const { emptyRegistryDelegates } = await import("../../helpers/registry-mocks");
  const writable = () => ({ findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) });
  return {
    mockAuth: vi.fn(),
    mockGetActiveTenantId: vi.fn(),
    mockRevalidate: vi.fn(),
    mockPrisma: {
      ...emptyRegistryDelegates(),
      tenant: { findUnique: vi.fn() },
      domain: { findUnique: vi.fn() },
      product: { findUnique: vi.fn() },
      entity: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      sharedEnum: writable(),
      customScalar: writable(),
      unionType: writable(),
      modelFieldDefinition: { findUnique: vi.fn(), update: vi.fn() },
      operation: { findUnique: vi.fn(), update: vi.fn() },
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
  };
});

vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidate }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));

import {
  createCustomScalarAction,
  createSharedEnumAction,
  createUnionTypeAction,
  updateCustomScalarAction,
  updateModelFieldAction,
  updateOperationAction,
  updateSharedEnumAction,
  updateUnionTypeAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

type Row = { id: string; name: string; tenantId: string; domainId: string | null; productId: string | null };
let existing: { sharedEnum: Row[]; customScalar: Row[]; unionType: Row[] };

const asAny = (v: unknown) => v as never;

beforeEach(() => {
  vi.clearAllMocks();
  existing = { sharedEnum: [], customScalar: [], unionType: [] };
  mockAuth.mockResolvedValue({ user: { id: "user-1" } });
  mockGetActiveTenantId.mockResolvedValue("tenant-1");
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
  mockPrisma.tenant.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "tenant-1" ? { id: "tenant-1" } : null));
  mockPrisma.domain.findUnique.mockResolvedValue({ id: "domain-1", tenantId: "tenant-1" });
  mockPrisma.product.findUnique.mockResolvedValue({ id: "prd-1", domainId: "domain-1", domain: { tenantId: "tenant-1" } });
  for (const kind of ["sharedEnum", "customScalar", "unionType"] as const) {
    mockPrisma[kind].findMany.mockImplementation(async ({ where }: { where: { tenantId: string; name: { equals: string } } }) =>
      existing[kind].filter((r) => r.tenantId === where.tenantId && r.name.toLowerCase() === where.name.equals.toLowerCase())
    );
    mockPrisma[kind].create.mockResolvedValue({ id: `${kind}-new` });
    mockPrisma[kind].update.mockResolvedValue({ id: "row-1" });
    mockPrisma[kind].findUnique.mockResolvedValue({ tenantId: "tenant-1" });
  }
  mockPrisma.modelFieldDefinition.findUnique.mockResolvedValue({ model: { domain: { tenantId: "tenant-1" } } });
  mockPrisma.modelFieldDefinition.update.mockResolvedValue({ id: "row-1" });
  mockPrisma.operation.findUnique.mockResolvedValue({ service: { tenantId: "tenant-1" } });
  mockPrisma.operation.update.mockResolvedValue({ id: "row-1" });
});

/** The payloads from the final review (D-I2) plus the other columns that place, version or identify a record. */
const ATTACKS: Array<Record<string, unknown>> = [
  { tenantId: "other", domainId: null, productId: null, name: "Taken" },
  { tenantId: "tenant-2" },
  { domainId: null },
  { productId: "prd-9" },
  { id: "someone-elses-id" },
  { createdAt: "2020-01-01T00:00:00.000Z" },
  { name: "Renamed" },
  { entityId: "ent2" },
  { modelId: "other-model" },
  { serviceId: "other-service" },
  { __proto__: { tenantId: "other" }, ["constructor"]: 1 },
  JSON.parse('{"__proto__": {"tenantId": "other"}}'),
];

const DATA_TYPE_CASES = [
  {
    label: "updateSharedEnumAction", kind: "Enum", model: "sharedEnum" as const,
    update: (id: unknown, data: unknown) => updateSharedEnumAction(asAny(id), asAny(data)),
    legit: { values: ["A", "B"], description: "Order status" },
    wrongType: [{ values: "A" }, { values: [1, 2] }, { description: 5 }],
  },
  {
    label: "updateCustomScalarAction", kind: "Scalar", model: "customScalar" as const,
    update: (id: unknown, data: unknown) => updateCustomScalarAction(asAny(id), asAny(data)),
    legit: { baseType: "string", format: null, pattern: "^[A-Z]+$", description: "Code" },
    wrongType: [{ baseType: 1 }, { format: 5 }, { pattern: ["x"] }, { description: {} }],
  },
  {
    label: "updateUnionTypeAction", kind: "Union", model: "unionType" as const,
    update: (id: unknown, data: unknown) => updateUnionTypeAction(asAny(id), asAny(data)),
    legit: { memberTypes: ["string", "int32"], description: "Id" },
    wrongType: [{ memberTypes: "string" }, { memberTypes: [null] }, { description: 1 }],
  },
];

describe.each(DATA_TYPE_CASES)("$label", ({ kind, model, update, legit, wrongType }) => {
  it("writes exactly the whitelisted columns of a row of the active tenant", async () => {
    expect(await update("row-1", legit)).toEqual({ success: true });
    expect(mockPrisma[model].update).toHaveBeenCalledTimes(1);
    expect(mockPrisma[model].update).toHaveBeenCalledWith({ where: { id: "row-1" }, data: legit });
    expect(mockRevalidate).toHaveBeenCalledWith("/schemas");
  });

  it.each(ATTACKS.map((a, i) => [i, a] as const))("rejects attack payload #%i with VALIDATION_ERROR and never reaches prisma.update", async (_i, attack) => {
    const result = await update("row-1", attack);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringMatching(/not editable/) });
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("rejects a payload that mixes a legitimate column with a forbidden one: nothing is written (no partial update)", async () => {
    const result = await update("row-1", { ...legit, tenantId: "other", domainId: null, productId: null, name: "Taken" });
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect((result as { error: string }).error).toContain("tenantId");
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
  });

  it("rejects wrong value types", async () => {
    for (const data of wrongType) {
      expect(await update("row-1", data), JSON.stringify(data)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
  });

  it("rejects a non-object payload instead of throwing", async () => {
    for (const data of [null, undefined, "x", 5, [], [legit]]) {
      expect(await update("row-1", data)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before any query", async () => {
    for (const id of [undefined, null, "", "  ", 5, {}, ["a"]]) {
      expect(await update(id, legit)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma[model].findUnique).not.toHaveBeenCalled();
  });

  it(`answers NOT_FOUND for a row of another tenant (indistinguishable from a missing one) and writes nothing`, async () => {
    mockPrisma[model].findUnique.mockResolvedValue({ tenantId: "tenant-2" });
    expect(await update("row-1", legit)).toEqual({ error: `${kind} not found`, code: "NOT_FOUND" });
    mockPrisma[model].findUnique.mockResolvedValue(null);
    expect(await update("row-1", legit)).toEqual({ error: `${kind} not found`, code: "NOT_FOUND" });
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it("returns the generic message (and logs the original) for an unexpected database failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma[model].update.mockRejectedValue(new Error("Invalid `prisma.x.update()` invocation: column \"secret_col\" does not exist"));
    const result = await update("row-1", legit);
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/prisma|secret_col/);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("requires a session", async () => {
    mockAuth.mockResolvedValue(null);
    expect(await update("row-1", legit)).toEqual({ error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(mockPrisma[model].update).not.toHaveBeenCalled();
  });
});

describe("updateModelFieldAction", () => {
  const fieldUpdate = (id: unknown, data: unknown) => updateModelFieldAction(asAny(id), asAny(data));

  it("writes exactly the whitelisted columns, with the name trimmed", async () => {
    expect(await fieldUpdate("mf-1", { name: "  email  ", type: "string", nullable: false, isKey: true, description: "d" })).toEqual({ success: true });
    expect(mockPrisma.modelFieldDefinition.update).toHaveBeenCalledWith({
      where: { id: "mf-1" },
      data: { name: "email", type: "string", nullable: false, isKey: true, description: "d" },
    });
  });

  it.each([{ modelId: "other-model" }, { sortOrder: 0 }, { tenantId: "other" }, { id: "x" }, { decorators: {} }, { name: "ok", modelId: "m2" }])(
    "rejects %j and never reaches prisma.update",
    async (attack) => {
      expect(await fieldUpdate("mf-1", attack)).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringMatching(/not editable/) });
      expect(mockPrisma.modelFieldDefinition.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a blank name, wrong types and a non-object payload", async () => {
    for (const data of [{ name: "   " }, { name: 5 }, { nullable: "yes" }, { type: null }, null, "x"]) {
      expect(await fieldUpdate("mf-1", data), JSON.stringify(data)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma.modelFieldDefinition.update).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a field whose model's domain belongs to another tenant, or that does not exist", async () => {
    mockPrisma.modelFieldDefinition.findUnique.mockResolvedValue({ model: { domain: { tenantId: "tenant-2" } } });
    expect(await fieldUpdate("mf-1", { name: "x" })).toEqual({ error: "Field not found", code: "NOT_FOUND" });
    mockPrisma.modelFieldDefinition.findUnique.mockResolvedValue(null);
    expect(await fieldUpdate("mf-1", { name: "x" })).toEqual({ error: "Field not found", code: "NOT_FOUND" });
    expect(mockPrisma.modelFieldDefinition.update).not.toHaveBeenCalled();
  });

  it("reports a duplicate name as a conflict, other failures generically", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma.modelFieldDefinition.update.mockRejectedValue(new Error("Unique constraint failed on the fields: (`modelId`,`name`)"));
    expect(await fieldUpdate("mf-1", { name: "email" })).toEqual({ error: 'Field "email" already exists', code: "NAME_CONFLICT" });
    mockPrisma.modelFieldDefinition.update.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(await fieldUpdate("mf-1", { name: "email" })).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("updateOperationAction", () => {
  const opUpdate = (id: unknown, data: unknown) => updateOperationAction(asAny(id), asAny(data));

  it("writes exactly the whitelisted columns, with the name trimmed", async () => {
    expect(await opUpdate("op-1", { name: " getOrder ", httpMethod: "GET", httpPath: "/orders/{id}", description: "d" })).toEqual({ success: true });
    expect(mockPrisma.operation.update).toHaveBeenCalledWith({
      where: { id: "op-1" },
      data: { name: "getOrder", httpMethod: "GET", httpPath: "/orders/{id}", description: "d" },
    });
  });

  it.each([{ serviceId: "other-service" }, { decorators: {} }, { tenantId: "other" }, { id: "x" }, { name: "ok", serviceId: "s2" }])(
    "rejects %j and never reaches prisma.update",
    async (attack) => {
      expect(await opUpdate("op-1", attack)).toMatchObject({ code: "VALIDATION_ERROR", error: expect.stringMatching(/not editable/) });
      expect(mockPrisma.operation.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a blank name, wrong types and a non-object payload", async () => {
    for (const data of [{ name: "" }, { httpMethod: 1 }, { httpPath: null }, undefined]) {
      expect(await opUpdate("op-1", data), JSON.stringify(data)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma.operation.update).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for an operation of another tenant's API, or a missing one", async () => {
    mockPrisma.operation.findUnique.mockResolvedValue({ service: { tenantId: "tenant-2" } });
    expect(await opUpdate("op-1", { name: "x" })).toEqual({ error: "Operation not found", code: "NOT_FOUND" });
    mockPrisma.operation.findUnique.mockResolvedValue(null);
    expect(await opUpdate("op-1", { name: "x" })).toEqual({ error: "Operation not found", code: "NOT_FOUND" });
    expect(mockPrisma.operation.update).not.toHaveBeenCalled();
  });
});

const CREATE_CASES = [
  { label: "createSharedEnumAction", model: "sharedEnum" as const, input: { values: ["A"] }, bad: [{ values: "A" }, { values: [1] }, { description: 5 }, {}],
    run: (domainId: unknown, data: unknown, target?: unknown) => createSharedEnumAction(asAny(domainId), asAny(data), asAny(target)) },
  { label: "createCustomScalarAction", model: "customScalar" as const, input: { baseType: "string" }, bad: [{ baseType: 1 }, { format: 5 }, { pattern: [] }, {}],
    run: (domainId: unknown, data: unknown, target?: unknown) => createCustomScalarAction(asAny(domainId), asAny(data), asAny(target)) },
  { label: "createUnionTypeAction", model: "unionType" as const, input: { memberTypes: ["A"] }, bad: [{ memberTypes: "A" }, { memberTypes: [null] }, { description: 1 }, {}],
    run: (domainId: unknown, data: unknown, target?: unknown) => createUnionTypeAction(asAny(domainId), asAny(data), asAny(target)) },
];

describe.each(CREATE_CASES)("$label input validation", ({ model, input, bad, run }) => {
  const MALFORMED_TARGETS: unknown[] = [
    { level: "BOGUS" }, { level: "DOMAIN" }, { level: "DOMAIN", domainId: 123 }, { level: "DOMAIN", domainId: {} },
    { level: "PRODUCT" }, { level: "PRODUCT", productId: "" }, { level: "PRODUCT", productId: 123 }, { level: "PRODUCT", productId: null },
    {}, [], "domain-1", 42, true,
  ];

  it.each(MALFORMED_TARGETS.map((t, i) => [i, t] as const))("rejects malformed scope target #%i with VALIDATION_ERROR before any query", async (_i, target) => {
    const result = await run("domain-1", { name: "Status", ...input }, target);
    expect(result).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(/prisma|invocation|Argument/i);
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.product.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma[model].create).not.toHaveBeenCalled();
  });

  it("rejects a domainId that is neither null nor a non-empty string when no target is given", async () => {
    for (const domainId of [123, {}, [], true]) {
      expect(await run(domainId, { name: "Status", ...input })).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma.domain.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma[model].create).not.toHaveBeenCalled();
  });

  it("still asks for a target when there is neither a domain nor a target", async () => {
    for (const domainId of [null, undefined, ""]) {
      expect(await run(domainId, { name: "Status", ...input })).toMatchObject({ error: "A domain or scope target is required" });
    }
  });

  it("rejects malformed details (non-object, non-string name, wrong value types, blank name) instead of throwing", async () => {
    for (const data of [null, undefined, "x", 5, [], { name: 123, ...input }, { name: null, ...input }, { name: "   ", ...input }, { ...input }]) {
      expect(await run("domain-1", data), JSON.stringify(data)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    for (const extra of bad) {
      expect(await run("domain-1", { name: "Status", ...extra }), JSON.stringify(extra)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(mockPrisma[model].create).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND (not IN_USE / raw text) for a TENANT target whose tenant does not exist", async () => {
    mockGetActiveTenantId.mockResolvedValue("deleted-tenant");
    const result = await run(null, { name: "Status", ...input }, { level: "TENANT", tenantId: "whatever" });
    expect(result).toEqual({ error: 'Tenant "deleted-tenant" not found' });
    expect(mockPrisma[model].create).not.toHaveBeenCalled();
  });

  it("returns the generic message, not driver text, when the write itself throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockPrisma[model].create.mockRejectedValue(new Error("Invalid `prisma.x.create()` invocation: Argument `tenantId` is missing"));
    const result = await run("domain-1", { name: "Status", ...input });
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});

describe("data-type names are stored trimmed", () => {
  it.each(CREATE_CASES)("$label trims the name before the registry check AND before the write", async ({ model, input, run }) => {
    expect(await run("domain-1", { name: "  Foo  ", ...input })).toEqual({ success: true });
    expect(mockPrisma[model].create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: "Foo" }) });
  });

  it("'Foo ' is rejected when 'Foo' already exists at another level of the same line (real registry)", async () => {
    existing.sharedEnum.push({ id: "enum-t", name: "Foo", tenantId: "tenant-1", domainId: null, productId: null });
    const result = await createSharedEnumAction("domain-1", { name: "Foo ", values: [] });
    expect(result).toMatchObject({ error: expect.stringMatching(/"Foo" is already used by Enum "Foo" at Enterprise level/) });
    expect(mockPrisma.sharedEnum.create).not.toHaveBeenCalled();
  });

  it("a name stored trimmed is found by a later 'Foo' at another level (the untrimmed 'Foo ' used to slip past the registry's equality filter)", async () => {
    await createSharedEnumAction("domain-1", { name: "Foo ", values: [] });
    const stored = (mockPrisma.sharedEnum.create.mock.calls[0][0] as { data: { name: string } }).data.name;
    existing.sharedEnum.push({ id: "enum-d", name: stored, tenantId: "tenant-1", domainId: "domain-1", productId: null });
    mockPrisma.sharedEnum.create.mockClear();
    const second = await createSharedEnumAction(null, { name: "Foo", values: [] }, { level: "PRODUCT", productId: "prd-1" });
    expect(second).toMatchObject({ error: expect.stringMatching(/already used/) });
    expect(mockPrisma.sharedEnum.create).not.toHaveBeenCalled();
  });
});
