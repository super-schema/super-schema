// @vitest-environment node
/**
 * `authorize(action, resource)`: the ONE decision every guarded call asks. UNAUTHORIZED without a principal, NOT_FOUND when the principal
 * cannot see the resource (the whole error is the very one a missing resource gets), FORBIDDEN (generic) when they can see it and hold too
 * low a role. And `resolveResourceRef(kind, id)`: one query, every kind, null for a missing row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_IDS } from "@/lib/access";
import { assign, globalAdmin, principalModule, principalOf, roleless, signInAs, signedOut, tenantMember, T1, T2 } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => {
  const delegate = () => ({ findUnique: vi.fn() });
  return {
    auth: vi.fn(),
    prisma: {
      entity: delegate(), field: delegate(), domain: delegate(), product: delegate(), modelDefinition: delegate(), modelFieldDefinition: delegate(),
      sharedEnum: delegate(), customScalar: delegate(), unionType: delegate(), serviceDefinition: delegate(), operation: delegate(),
      eventSpec: delegate(), trait: delegate(), tenant: delegate(),
    },
  };
});
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../../helpers/access-mocks")).principalModule);

import {
  NOT_AUTHENTICATED,
  authorize,
  authorizeSubject,
  authorizeTenant,
  notFoundError,
  resolveResourceRef,
  toActionResult,
  type ResourceKind,
} from "@/lib/action-context";

const DOM_A = { tenantId: T1, domainId: "dom-a", productId: null };
const DOM_B = { tenantId: T1, domainId: "dom-b", productId: null };
const PRODUCT_IN_A = { tenantId: T1, domainId: "dom-a", productId: "prod-a1" };
const TENANT_LEVEL = { tenantId: T1, domainId: null, productId: null };
const FOREIGN = { tenantId: T2, domainId: "dom-x", productId: null };

beforeEach(() => {
  vi.clearAllMocks();
  signInAs(globalAdmin());
});

describe("no principal (signed out, a stale session, a disabled user)", () => {
  it("is UNAUTHORIZED for every action and resource, and says exactly what NOT_AUTHENTICATED says", async () => {
    signedOut();
    for (const action of ACTION_IDS) {
      const result = await authorize(action, PRODUCT_IN_A);
      expect(result, action).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
      expect(toActionResult(result)).toEqual(NOT_AUTHENTICATED);
    }
  });
});

describe("a signed-in user with no role at all", () => {
  beforeEach(() => signInAs(roleless()));

  it("sees nothing: every resource-bearing action answers NOT_FOUND, whatever the action and the resource (a missing resource answers the same)", async () => {
    const missing = notFoundError();
    for (const action of ACTION_IDS) {
      const result = await authorize(action, PRODUCT_IN_A);
      if (action === "notification.own" || action === "profile.own") continue;
      if (["platform.admin", "emitter.manage", "git.manage", "classification.manage", "tenant.create"].includes(action)) continue; // global level: no resource to hide
      expect(result, action).toEqual({ success: false, error: missing });
    }
    for (const resource of [DOM_A, DOM_B, TENANT_LEVEL, FOREIGN, { tenantId: "no-such-tenant" }]) {
      expect(await authorize("entity.read", resource)).toEqual({ success: false, error: missing });
      expect(await authorize("entity.write", resource)).toEqual({ success: false, error: missing });
    }
  });

  it("still gets their own notifications and profile (any active principal passes the self-level actions)", async () => {
    expect(await authorize("notification.own", TENANT_LEVEL)).toMatchObject({ success: true });
    expect(await authorize("profile.own", TENANT_LEVEL)).toMatchObject({ success: true });
  });

  it("is refused the platform actions with a generic FORBIDDEN (they have no resource to hide)", async () => {
    for (const action of ["platform.admin", "emitter.manage", "git.manage", "classification.manage", "tenant.create"] as const) {
      expect(await authorize(action, TENANT_LEVEL), action).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
  });
});

describe("a tenant member", () => {
  it("a tenant VIEWER reads in the tenant, is FORBIDDEN (generic) to write there, and sees nothing of another tenant", async () => {
    signInAs(tenantMember("VIEWER", T1));
    expect(await authorize("entity.read", PRODUCT_IN_A)).toMatchObject({ success: true });
    expect(await authorize("entity.read", TENANT_LEVEL)).toMatchObject({ success: true });
    expect(await authorize("entity.write", PRODUCT_IN_A)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await authorize("domain.create", { tenantId: T1 })).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await authorize("entity.read", FOREIGN)).toEqual({ success: false, error: notFoundError() });
  });

  it("a tenant ADMIN may administer their tenant and nothing of another", async () => {
    signInAs(tenantMember("ADMIN", T1));
    for (const action of ["user.manage", "domain.delete", "tenant.admin", "entity.write", "entity.publish"] as const) {
      expect(await authorize(action, PRODUCT_IN_A), action).toMatchObject({ success: true });
    }
    expect(await authorize("user.manage", { tenantId: T2 })).toEqual({ success: false, error: notFoundError() });
    // ... and is not a platform administrator
    expect(await authorize("platform.admin", PRODUCT_IN_A)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("the FORBIDDEN answer is generic: no role, action id, tenant or resource id in it, the same text for every action and resource", async () => {
    signInAs(tenantMember("VIEWER", T1));
    const answers = new Set<string>();
    for (const action of ["entity.write", "entity.publish", "domain.create", "user.manage", "compliance.audit"] as const) {
      const result = await authorize(action, { tenantId: T1, domainId: "dom-a", productId: "prod-a1" });
      expect(result.success).toBe(false);
      answers.add(JSON.stringify(result));
    }
    expect(answers.size).toBe(1);
    const text = [...answers][0];
    for (const leak of ["VIEWER", "AUTHOR", "STEWARD", "ADMIN", "COMPLIANCE", "entity", "domain", "tenant", "dom-a", "prod-a1", T1]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});

describe("a domain-scoped AUTHOR (the scopes take effect)", () => {
  const author = () => principalOf([assign.domain("AUTHOR", T1, "dom-a")]);
  beforeEach(() => signInAs(author()));

  it("passes for an entity in their domain, in a product of it, and for the domain itself", async () => {
    expect(await authorize("entity.write", DOM_A)).toMatchObject({ success: true });
    expect(await authorize("entity.write", PRODUCT_IN_A)).toMatchObject({ success: true });
    expect(await authorize("entity.read", DOM_A)).toMatchObject({ success: true });
  });

  it("is refused for a SIBLING domain: it reads like a missing resource (they hold no role there)", async () => {
    expect(await authorize("entity.write", DOM_B)).toEqual({ success: false, error: notFoundError() });
    expect(await authorize("entity.read", DOM_B)).toEqual({ success: false, error: notFoundError() });
  });

  it("is refused for a TENANT-LEVEL entity (no domain): a domain role does not reach it", async () => {
    expect(await authorize("entity.write", TENANT_LEVEL)).toEqual({ success: false, error: notFoundError() });
  });

  it("holds too low a role in their own domain: FORBIDDEN, not NOT_FOUND (they can see it)", async () => {
    expect(await authorize("entity.publish", DOM_A)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
  });

  it("is a member of the tenant for tenant-wide actions: they are told FORBIDDEN, not 'not found'", async () => {
    expect(await authorize("domain.create", { tenantId: T1 })).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await authorize("compliance.audit", { tenantId: T1 })).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await authorize("glossary.write", { tenantId: T1 })).toMatchObject({ success: true });
    expect(await authorize("tenant.access", { tenantId: T1 })).toMatchObject({ success: true });
    expect(await authorize("tenant.access", { tenantId: T2 })).toEqual({ success: false, error: notFoundError() });
  });

  it("a product-scoped role covers that product only", async () => {
    signInAs(principalOf([assign.product("AUTHOR", T1, "dom-a", "prod-a1")]));
    expect(await authorize("entity.write", PRODUCT_IN_A)).toMatchObject({ success: true });
    expect(await authorize("entity.write", { tenantId: T1, domainId: "dom-a", productId: "prod-a2" })).toEqual({ success: false, error: notFoundError() });
    expect(await authorize("entity.write", DOM_A)).toEqual({ success: false, error: notFoundError() });
  });
});

describe("a global administrator", () => {
  it("passes every action on every resource, including a tenant they hold no tenant role in and the platform actions", async () => {
    signInAs(globalAdmin());
    for (const action of ACTION_IDS) {
      for (const resource of [PRODUCT_IN_A, TENANT_LEVEL, FOREIGN]) {
        expect(await authorize(action, resource), `${action} ${JSON.stringify(resource)}`).toMatchObject({ success: true });
      }
    }
  });

  it("gets the principal back, so the caller can build a service context from it", async () => {
    const admin = globalAdmin("admin-9");
    signInAs(admin);
    const result = await authorize("entity.write", PRODUCT_IN_A);
    expect(result).toEqual({ success: true, data: admin });
  });
});

describe("a foreign resource is indistinguishable from a missing one (the whole error)", () => {
  it("authorize on a resource of another tenant, a missing row (resolveResourceRef null) and a roleless user's own tenant are the identical object", async () => {
    signInAs(tenantMember("ADMIN", T1));
    const foreign = await authorize("entity.write", FOREIGN);

    mocks.prisma.entity.findUnique.mockResolvedValue(null);
    const missing = await authorizeSubject("entity.write", { kind: "entity", id: "gone" });

    signInAs(roleless());
    const asRoleless = await authorize("entity.write", PRODUCT_IN_A);

    expect(foreign).toEqual(missing);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(JSON.stringify(asRoleless)).toBe(JSON.stringify(missing));
    expect(foreign).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
    expect(toActionResult(foreign)).toEqual(toActionResult(missing));
  });

  it("a caller-supplied not-found answer is used for BOTH the missing row and the resource that cannot be seen", async () => {
    signInAs(tenantMember("ADMIN", T1));
    const answer = { code: "NOT_FOUND", message: 'Product "p1" not found' };
    mocks.prisma.product.findUnique.mockResolvedValueOnce(null);
    const missing = await authorizeSubject("product.update", { kind: "product", id: "p1" }, answer);
    mocks.prisma.product.findUnique.mockResolvedValueOnce({ domainId: "dom-x", domain: { tenantId: T2 } });
    const foreign = await authorizeSubject("product.update", { kind: "product", id: "p1" }, answer);
    expect(missing).toEqual({ success: false, error: answer });
    expect(foreign).toEqual({ success: false, error: answer });
  });
});

describe("authorize fails closed", () => {
  it("an action id that is not in the table is FORBIDDEN, never allowed (not even for an administrator)", async () => {
    for (const action of ["entity.erase", "", "constructor", "__proto__", undefined, null, 5] as never[]) {
      expect(await authorize(action, PRODUCT_IN_A), String(action)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
  });

  it("a malformed resource is NOT_FOUND for a user who needs one, and does not throw", async () => {
    signInAs(tenantMember("ADMIN", T1));
    for (const resource of [undefined, null, {}, { tenantId: 5 }, { tenantId: "" }, { tenantId: "a:b" }, "tenant-1", { tenantId: T1, domainId: 7 }] as never[]) {
      expect(await authorize("entity.write", resource), JSON.stringify(resource)).toEqual({ success: false, error: notFoundError() });
    }
  });

  it("authorizeTenant judges the tenant as a whole", async () => {
    signInAs(principalOf([assign.domain("STEWARD", T1, "dom-a")]));
    expect(await authorizeTenant("domain.create", T1)).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    signInAs(tenantMember("STEWARD", T1));
    expect(await authorizeTenant("domain.create", T1)).toMatchObject({ success: true });
    expect(await authorizeTenant("domain.create", T2)).toEqual({ success: false, error: notFoundError() });
  });

  it("a resource subject that names an unknown kind or a malformed id is NOT_FOUND without any query", async () => {
    for (const subject of [{ kind: "constructor", id: "x" }, { kind: "nope", id: "x" }, { kind: "entity", id: "" }, { kind: "entity", id: 5 }, { kind: "entity", id: null }] as never[]) {
      expect(await authorizeSubject("entity.read", subject), JSON.stringify(subject)).toEqual({ success: false, error: notFoundError() });
    }
    expect(mocks.prisma.entity.findUnique).not.toHaveBeenCalled();
  });

  it("asks the principal ONCE per decision, so a request's guards cost one cached read", async () => {
    await authorize("entity.read", PRODUCT_IN_A);
    expect(principalModule.getPrincipal).toHaveBeenCalledTimes(1);
  });
});

describe("resolveResourceRef (one query per call; tenant, domain and product of the row)", () => {
  const entityRow = { tenantId: T1, domainId: "dom-a", productId: "prod-a1", product: { domainId: "dom-a" } };

  /** Every kind: the delegate it reads, a stored row, and the reference that row must give. */
  const KINDS: Array<{ kind: ResourceKind; delegate: keyof typeof mocks.prisma; row: unknown; ref: unknown }> = [
    { kind: "entity", delegate: "entity", row: entityRow, ref: { tenantId: T1, domainId: "dom-a", productId: "prod-a1" } },
    { kind: "field", delegate: "field", row: { entity: entityRow }, ref: { tenantId: T1, domainId: "dom-a", productId: "prod-a1" } },
    { kind: "domain", delegate: "domain", row: { tenantId: T1 }, ref: { tenantId: T1, domainId: "ID", productId: null } },
    { kind: "product", delegate: "product", row: { domainId: "dom-a", domain: { tenantId: T1 } }, ref: { tenantId: T1, domainId: "dom-a", productId: "ID" } },
    { kind: "model", delegate: "modelDefinition", row: { domainId: "dom-a", domain: { tenantId: T1 } }, ref: { tenantId: T1, domainId: "dom-a", productId: null } },
    {
      kind: "modelField", delegate: "modelFieldDefinition", row: { model: { domainId: "dom-a", domain: { tenantId: T1 } } },
      ref: { tenantId: T1, domainId: "dom-a", productId: null },
    },
    { kind: "sharedEnum", delegate: "sharedEnum", row: { tenantId: T1, domainId: "dom-a", productId: null, product: null }, ref: { tenantId: T1, domainId: "dom-a", productId: null } },
    { kind: "customScalar", delegate: "customScalar", row: { tenantId: T1, domainId: null, productId: null, product: null }, ref: { tenantId: T1, domainId: null, productId: null } },
    { kind: "unionType", delegate: "unionType", row: entityRow, ref: { tenantId: T1, domainId: "dom-a", productId: "prod-a1" } },
    { kind: "service", delegate: "serviceDefinition", row: { tenantId: T1, domainId: "dom-a", productId: null, product: null }, ref: { tenantId: T1, domainId: "dom-a", productId: null } },
    { kind: "operation", delegate: "operation", row: { service: { tenantId: T1, domainId: "dom-a", productId: null, product: null } }, ref: { tenantId: T1, domainId: "dom-a", productId: null } },
    { kind: "event", delegate: "eventSpec", row: entityRow, ref: { tenantId: T1, domainId: "dom-a", productId: "prod-a1" } },
    { kind: "trait", delegate: "trait", row: { tenantId: T1, domainId: null, productId: null, product: null }, ref: { tenantId: T1, domainId: null, productId: null } },
  ];

  it.each(KINDS)("$kind: one query by id, the tenant/domain/product of the row", async ({ kind, delegate, row, ref }) => {
    mocks.prisma[delegate].findUnique.mockResolvedValue(row);
    expect(await resolveResourceRef(kind, "ID")).toEqual(ref);
    expect(mocks.prisma[delegate].findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.prisma[delegate].findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ID" } }));
    const queries = Object.values(mocks.prisma).reduce((n, d) => n + d.findUnique.mock.calls.length, 0);
    expect(queries).toBe(1);
  });

  it.each(KINDS)("$kind: null for a missing row", async ({ kind, delegate }) => {
    mocks.prisma[delegate].findUnique.mockResolvedValue(null);
    expect(await resolveResourceRef(kind, "ID")).toBeNull();
  });

  it("an entity of a product whose own domain column is empty takes the domain of its product, so a domain role still reaches it", async () => {
    mocks.prisma.entity.findUnique.mockResolvedValue({ tenantId: T1, domainId: null, productId: "prod-a1", product: { domainId: "dom-a" } });
    expect(await resolveResourceRef("entity", "e1")).toEqual({ tenantId: T1, domainId: "dom-a", productId: "prod-a1" });
  });

  it("the reference it returns is what the policy needs: a domain AUTHOR is judged against the domain the row lives in", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T1, "dom-a")]));
    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T1, domainId: "dom-a", productId: null, product: null });
    expect(await authorizeSubject("entity.write", { kind: "entity", id: "e-in-a" })).toMatchObject({ success: true });
    mocks.prisma.entity.findUnique.mockResolvedValueOnce({ tenantId: T1, domainId: "dom-b", productId: null, product: null });
    expect(await authorizeSubject("entity.write", { kind: "entity", id: "e-in-b" })).toEqual({ success: false, error: notFoundError() });
  });

  it.each([undefined, null, "", "   ", 5, {}, ["id"], true])("is null for the malformed id %j without any query", async (id) => {
    for (const { kind } of KINDS) expect(await resolveResourceRef(kind, id)).toBeNull();
    expect(Object.values(mocks.prisma).reduce((n, d) => n + d.findUnique.mock.calls.length, 0)).toBe(0);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "tenant", "user", ""])("is null for the kind %j without any query", async (kind) => {
    expect(await resolveResourceRef(kind as ResourceKind, "id-1")).toBeNull();
    expect(Object.values(mocks.prisma).reduce((n, d) => n + d.findUnique.mock.calls.length, 0)).toBe(0);
  });

  it("lets a database failure propagate (callers answer it generically, never as 'not found')", async () => {
    mocks.prisma.entity.findUnique.mockRejectedValue(new Error("connection lost"));
    await expect(resolveResourceRef("entity", "id-1")).rejects.toThrow("connection lost");
  });
});
