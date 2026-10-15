import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared by-id guards of the older entity / model / API / data-type / product actions (src/lib/action-context.ts):
// `inActiveTenant` (row or parent -> tenant), `targetInActiveTenant` (a create's scope target), `notFoundFailure`,
// `unexpectedFailure` and `failureOf`.

const { mockPrisma, mockGetActiveTenantId } = vi.hoisted(() => {
  const delegate = () => ({ findUnique: vi.fn() });
  return {
    mockGetActiveTenantId: vi.fn(),
    mockPrisma: {
      entity: delegate(), field: delegate(), domain: delegate(), product: delegate(), modelDefinition: delegate(),
      modelFieldDefinition: delegate(), sharedEnum: delegate(), customScalar: delegate(), unionType: delegate(),
      serviceDefinition: delegate(), operation: delegate(), tenant: delegate(),
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));

import {
  failureOf,
  inActiveTenant,
  notFoundFailure,
  targetInActiveTenant,
  unexpectedFailure,
  type TenantScopedKind,
} from "@/lib/action-context";
import { AuditUserMissingError } from "@/lib/audit";
import { resolveScope } from "@/lib/asset-scope";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const T = "tenant-1";

/** Every kind, the Prisma delegate it reads, and the row shape that places it in tenant `t` (itself or through its parent). */
const KINDS: Array<{ kind: TenantScopedKind; delegate: keyof typeof mockPrisma; rowIn: (t: string) => unknown }> = [
  { kind: "entity", delegate: "entity", rowIn: (t) => ({ tenantId: t }) },
  { kind: "field", delegate: "field", rowIn: (t) => ({ entity: { tenantId: t } }) },
  { kind: "domain", delegate: "domain", rowIn: (t) => ({ tenantId: t }) },
  { kind: "product", delegate: "product", rowIn: (t) => ({ domain: { tenantId: t } }) },
  { kind: "model", delegate: "modelDefinition", rowIn: (t) => ({ domain: { tenantId: t } }) },
  { kind: "modelField", delegate: "modelFieldDefinition", rowIn: (t) => ({ model: { domain: { tenantId: t } } }) },
  { kind: "sharedEnum", delegate: "sharedEnum", rowIn: (t) => ({ tenantId: t }) },
  { kind: "customScalar", delegate: "customScalar", rowIn: (t) => ({ tenantId: t }) },
  { kind: "unionType", delegate: "unionType", rowIn: (t) => ({ tenantId: t }) },
  { kind: "service", delegate: "serviceDefinition", rowIn: (t) => ({ tenantId: t }) },
  { kind: "operation", delegate: "operation", rowIn: (t) => ({ service: { tenantId: t } }) },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveTenantId.mockResolvedValue(T);
});

describe.each(KINDS)("inActiveTenant($kind)", ({ kind, delegate, rowIn }) => {
  it("is true for a row of the active tenant (reading exactly the tenant path of the row)", async () => {
    mockPrisma[delegate].findUnique.mockResolvedValue(rowIn(T));
    expect(await inActiveTenant(kind, "id-1")).toBe(true);
    expect(mockPrisma[delegate].findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma[delegate].findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "id-1" } }));
  });

  it("is false for a row of another tenant", async () => {
    mockPrisma[delegate].findUnique.mockResolvedValue(rowIn("tenant-2"));
    expect(await inActiveTenant(kind, "id-1")).toBe(false);
  });

  it("is false for a missing row, the same as for a foreign one", async () => {
    mockPrisma[delegate].findUnique.mockResolvedValue(null);
    expect(await inActiveTenant(kind, "id-1")).toBe(false);
  });

  it.each([undefined, null, "", "   ", 5, {}, ["id-1"], true])("is false for the malformed id %j without any query", async (id) => {
    expect(await inActiveTenant(kind, id)).toBe(false);
    expect(mockPrisma[delegate].findUnique).not.toHaveBeenCalled();
    expect(mockGetActiveTenantId).not.toHaveBeenCalled();
  });

  it("follows the ACTIVE tenant (a row that is foreign today is the caller's after a tenant switch)", async () => {
    mockPrisma[delegate].findUnique.mockResolvedValue(rowIn("tenant-2"));
    expect(await inActiveTenant(kind, "id-1")).toBe(false);
    mockGetActiveTenantId.mockResolvedValue("tenant-2");
    expect(await inActiveTenant(kind, "id-1")).toBe(true);
  });

  it("lets a database failure propagate (callers answer it generically, never as 'not found')", async () => {
    mockPrisma[delegate].findUnique.mockRejectedValue(new Error("connection lost"));
    await expect(inActiveTenant(kind, "id-1")).rejects.toThrow("connection lost");
  });
});

describe("targetInActiveTenant", () => {
  const SCENARIOS = [
    {
      label: "DOMAIN", target: { level: "DOMAIN" as const, domainId: "d1" },
      load: (row: unknown) => mockPrisma.domain.findUnique.mockResolvedValue(row),
      own: { id: "d1", tenantId: T }, foreign: { id: "d1", tenantId: "tenant-2" },
    },
    {
      label: "PRODUCT", target: { level: "PRODUCT" as const, productId: "p1" },
      load: (row: unknown) => mockPrisma.product.findUnique.mockResolvedValue(row),
      own: { id: "p1", domainId: "d1", domain: { tenantId: T } }, foreign: { id: "p1", domainId: "d1", domain: { tenantId: "tenant-2" } },
    },
    {
      label: "TENANT", target: { level: "TENANT" as const, tenantId: "tenant-2" },
      load: (row: unknown) => mockPrisma.tenant.findUnique.mockResolvedValue(row),
      own: null, foreign: { id: "tenant-2" },
    },
  ];

  it.each(SCENARIOS)("$label: succeeds for a target of the active tenant", async ({ target, load, own }) => {
    if (target.level === "TENANT") {
      mockGetActiveTenantId.mockResolvedValue("tenant-2");
      load({ id: "tenant-2" });
    } else {
      load(own);
    }
    expect(await targetInActiveTenant(target)).toEqual({ success: true, data: undefined });
  });

  it.each(SCENARIOS)("$label: a target of another tenant reads EXACTLY like a missing one (same code, same message)", async ({ target, load, foreign }) => {
    load(foreign);
    const foreignAnswer = await targetInActiveTenant(target);
    load(null);
    const missingAnswer = await targetInActiveTenant(target);
    expect(foreignAnswer).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(foreignAnswer)).toBe(JSON.stringify(missingAnswer));
    // ...and the message is the one resolveScope itself gives a missing target (so callers that used to forward it see no change).
    const viaResolveScope = await resolveScope(mockPrisma as never, target);
    expect(foreignAnswer).toEqual(viaResolveScope);
  });
});

describe("notFoundFailure", () => {
  it("is the one wire shape of a foreign or missing by-id row", () => {
    expect(notFoundFailure("Field")).toEqual({ error: "Field not found", code: "NOT_FOUND" });
  });
});

describe("unexpectedFailure", () => {
  it("logs the original and answers the generic message, never the driver / Prisma / TypeError text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prismaText = "Invalid `prisma.field.create()` invocation in\n/Users/dev/src/my/super-schema/src/app/actions.ts:145:30\n\n  142 name,\n→ 145 prisma.field.create({ data: { name: undefined";
    for (const thrown of [new Error(prismaText), new TypeError("Cannot read properties of undefined (reading 'map')"), "boom", null]) {
      const result = unexpectedFailure("someAction", thrown);
      expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
      expect(JSON.stringify(result)).not.toMatch(/prisma|Users|actions\.ts|undefined|map/);
    }
    expect(spy).toHaveBeenCalledWith("[someAction] unexpected error", expect.any(Error));
    spy.mockRestore();
  });

  it("answers a stale session (the session's user no longer exists) with its actionable line, not the generic one", () => {
    expect(unexpectedFailure("x", new AuditUserMissingError("u1"))).toEqual({
      error: "Your session is stale. Sign out and sign in again, then retry.",
      code: "UNAUTHORIZED",
    });
  });

  it("re-throws Next control-flow errors (redirect / notFound digests) untouched", () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/schemas;307;" });
    expect(() => unexpectedFailure("x", redirect)).toThrow(redirect);
    const notFound = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(() => unexpectedFailure("x", notFound)).toThrow(notFound);
  });
});

describe("failureOf", () => {
  it("passes a domain failure through with its message and code", () => {
    expect(failureOf({ code: "INVALID_TRANSITION", message: "Cannot transition from DRAFT to RETIRED" }, "x")).toEqual({
      error: "Cannot transition from DRAFT to RETIRED",
      code: "INVALID_TRANSITION",
    });
  });

  it("replaces the raw text of a DB_ERROR / INTERNAL_ERROR with the generic message and logs it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      const result = failureOf({ code, message: 'relation "entities" does not exist at 10.0.0.5:5432' }, "someAction");
      expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code });
    }
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
