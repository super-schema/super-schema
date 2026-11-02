// @vitest-environment node
/**
 * Access control over governance and retention: the requests list, approve and reject (`governance.decide`: a steward and above, so a compliance
 * officer and an administrator too), and the retention page (reads: `entity.read`; the policy edit `retention.write`, a steward's act). The REAL guard
 * runs; what is replaced is the database look-ups and the services behind the actions, which are the "effects" a refused caller must never reach.
 * For each operation: nobody signed in, a user with no role, every role of the ladder, a resource of another tenant (also for a user who holds a
 * role there: it is not the tenant in view), domain-scoped and product-scoped holders on the right and on the wrong scope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf, roleless, signInAs, signedOut, tenantMember } from "../../helpers/access-mocks";
import { ROLE_HIERARCHY, type Role } from "@/types/schemas/rbac";
import { roleAtLeast } from "@/lib/access";

const T = "tenant-1";
const OTHER = "tenant-2";

const h = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    activeTenant: fn(), revalidatePath: fn(),
    findRequest: fn(), findEntity: fn(), findManyEntities: fn(), updateEntity: fn(),
    getAllRequests: fn(), approveRequest: fn(), rejectRequest: fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    governanceRequest: { findUnique: h.findRequest },
    entity: { findUnique: h.findEntity, findMany: h.findManyEntities, update: h.updateEntity },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/services/governance.service", () => ({ getAllRequests: h.getAllRequests, approveRequest: h.approveRequest, rejectRequest: h.rejectRequest }));

import { approveGovernanceRequestAction, getGovernanceRequestsAction, rejectGovernanceRequestAction } from "@/app/(dashboard)/governance/actions";
import { getEntitiesForRetentionAction, updateRetentionPolicyAction } from "@/app/(dashboard)/governance/retention/actions";

const GENERIC_FORBIDDEN = "You do not have permission to do this";
const POLICY = { strategy: "age-based", period: 7, periodUnit: "years", action: "archive" };
const EFFECTS = [h.approveRequest, h.rejectRequest, h.updateEntity, h.revalidatePath];
const reached = () => EFFECTS.filter((effect) => effect.mock.calls.length > 0);

/** Where the request `req-1`, its entity and the entity of the retention actions live. */
function place(tenantId: string, domainId = "dom-a") {
  const row = { tenantId, domainId, productId: "prod-a", product: { domainId }, metadata: {} };
  h.findRequest.mockResolvedValue({ entityId: "ent-1" });
  h.findEntity.mockResolvedValue(row);
}

type Op = { label: string; call: () => Promise<unknown>; min: Role; error: (answer: unknown) => string | undefined };
const errorOf = (answer: unknown) => (answer as { error?: string } | null)?.error;

const OPS: Op[] = [
  { label: "approveGovernanceRequestAction", call: () => approveGovernanceRequestAction("req-1", "ok"), min: "STEWARD", error: errorOf },
  { label: "rejectGovernanceRequestAction", call: () => rejectGovernanceRequestAction("req-1", "no"), min: "STEWARD", error: errorOf },
  { label: "updateRetentionPolicyAction", call: () => updateRetentionPolicyAction("ent-1", POLICY), min: "STEWARD", error: errorOf },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  place(T);
  h.approveRequest.mockResolvedValue({ success: true, data: { id: "apr-1" } });
  h.rejectRequest.mockResolvedValue({ success: true, data: { id: "apr-1" } });
  h.updateEntity.mockResolvedValue({ id: "ent-1" });
  h.getAllRequests.mockResolvedValue({ success: true, data: [] });
  h.findManyEntities.mockResolvedValue([]);
});

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing, not even a look-up", async () => {
    signedOut();
    expect(op.error(await op.call())).toBe("Not authenticated");
    expect(reached()).toHaveLength(0);
    expect(h.findRequest).not.toHaveBeenCalled();
    expect(h.findEntity).not.toHaveBeenCalled();
  });

  it("answers a user with no role at all as a missing resource and reaches nothing", async () => {
    signInAs(roleless());
    expect(op.error(await op.call())).toMatch(/not found$/);
    expect(reached()).toHaveLength(0);
  });

  it("is allowed from steward up (a compliance officer and an administrator too) and refused (generic, nothing reached) below", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      place(T);
      h.approveRequest.mockResolvedValue({ success: true, data: { id: "apr-1" } });
      h.rejectRequest.mockResolvedValue({ success: true, data: { id: "apr-1" } });
      h.updateEntity.mockResolvedValue({ id: "ent-1" });
      const answer = await op.call();
      if (roleAtLeast(role, op.min)) {
        expect(op.error(answer), `${role}: ${JSON.stringify(answer)}`).toBeUndefined();
        expect(reached(), role).not.toHaveLength(0);
      } else {
        expect(op.error(answer), role).toBe(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it("answers a resource of ANOTHER tenant exactly as a missing one, even for an administrator of both tenants, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    place(OTHER);
    const foreign = await op.call();
    h.findRequest.mockResolvedValue(null);
    h.findEntity.mockResolvedValue(null);
    const missing = await op.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(op.error(foreign)).toMatch(/not found$/);
    expect(reached()).toHaveLength(0);
  });

  it("follows the ACTIVE tenant: a role in the resource's tenant does not help while another tenant is in view", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.activeTenant.mockResolvedValue(OTHER);
    expect(op.error(await op.call())).toMatch(/not found$/);
    expect(reached()).toHaveLength(0);
  });

  it("domain-scoped: a steward of the entity's domain may, an author of it may not, a steward of a sibling domain reads it as missing", async () => {
    signInAs(principalOf([assign.domain("STEWARD", T, "dom-a")]));
    expect(op.error(await op.call())).toBeUndefined();
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")]));
    expect(op.error(await op.call())).toBe(GENERIC_FORBIDDEN);
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    expect(op.error(await op.call())).toMatch(/not found$/);
    expect(reached()).toHaveLength(0);
  });

  it("product-scoped: a steward of the entity's product may, a steward of a sibling product reads it as missing", async () => {
    signInAs(principalOf([assign.product("STEWARD", T, "dom-a", "prod-a")]));
    expect(op.error(await op.call())).toBeUndefined();
    vi.clearAllMocks();
    signInAs(principalOf([assign.product("STEWARD", T, "dom-a", "prod-b")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    expect(op.error(await op.call())).toMatch(/not found$/);
    expect(reached()).toHaveLength(0);
  });
});

describe("the decision actions", () => {
  it("answer a request whose entity is gone as missing for everybody, a platform administrator included", async () => {
    signInAs(principalOf([assign.global()]));
    h.findEntity.mockResolvedValue(null);
    expect(await approveGovernanceRequestAction("req-1", null)).toEqual({ error: 'Governance request "req-1" not found' });
    expect(h.approveRequest).not.toHaveBeenCalled();
  });

  it("hand the service the principal's assignments and the ACTIVE tenant, never a role label or anything of the client's", async () => {
    const assignments = [assign.tenant("COMPLIANCE_OFFICER", T)];
    signInAs(principalOf(assignments, { userId: "u-9" }));
    await rejectGovernanceRequestAction("req-1", "no");
    expect(h.rejectRequest).toHaveBeenCalledWith("req-1", "no", { userId: "u-9", assignments, tenantId: T });
  });

  it("answer a malformed request id as a missing request, with no look-up", async () => {
    for (const bad of [5, null, undefined, {}]) {
      expect(await approveGovernanceRequestAction(bad as never, null)).toEqual({ error: 'Governance request "" not found' });
    }
    expect(h.findRequest).not.toHaveBeenCalled();
    expect(h.approveRequest).not.toHaveBeenCalled();
  });

  it("read the request's entity on EVERY call, so a missing request and one of another tenant cost the same look-ups", async () => {
    h.findRequest.mockResolvedValue(null);
    await approveGovernanceRequestAction("req-1", null);
    const missingLookups = [h.findRequest.mock.calls.length, h.findEntity.mock.calls.length];
    vi.clearAllMocks();
    place(OTHER);
    await approveGovernanceRequestAction("req-1", null);
    expect([h.findRequest.mock.calls.length, h.findEntity.mock.calls.length]).toEqual(missingLookups);
  });
});

describe("getGovernanceRequestsAction", () => {
  it("answers nobody signed in and a user with no role without reading anything", async () => {
    signedOut();
    expect(await getGovernanceRequestsAction()).toEqual({ error: "Not authenticated" });
    signInAs(roleless());
    expect(await getGovernanceRequestsAction()).toEqual({ error: "Governance requests not found" });
    expect(h.getAllRequests).not.toHaveBeenCalled();
  });

  it("is open to every role of the ladder (reading is a viewer's act) and asks only the ACTIVE tenant", async () => {
    for (const role of ROLE_HIERARCHY) {
      signInAs(tenantMember(role, T));
      expect(await getGovernanceRequestsAction(), role).toEqual({ success: true, data: [] });
    }
    for (const call of h.getAllRequests.mock.calls) expect(call[0]).toBe(T);
  });

  it("a role in another tenant than the one in view lists nothing", async () => {
    signInAs(tenantMember("ADMIN", OTHER));
    expect(await getGovernanceRequestsAction()).toEqual({ error: "Governance requests not found" });
    expect(h.getAllRequests).not.toHaveBeenCalled();
  });

  it("hands the service a visibility filter that lists only the requests of entities the caller's roles cover", async () => {
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a"), assign.product("VIEWER", T, "dom-b", "prod-x")]));
    await getGovernanceRequestsAction();
    const visible = h.getAllRequests.mock.calls[0][1] as (place: { tenantId: string; domainId: string | null; productId: string | null }) => boolean;
    expect(visible({ tenantId: T, domainId: "dom-a", productId: "prod-a" })).toBe(true);
    expect(visible({ tenantId: T, domainId: "dom-a", productId: null })).toBe(true);
    expect(visible({ tenantId: T, domainId: "dom-b", productId: "prod-x" })).toBe(true);
    expect(visible({ tenantId: T, domainId: "dom-b", productId: "prod-y" })).toBe(false);
    expect(visible({ tenantId: T, domainId: "dom-c", productId: null })).toBe(false);
    expect(visible({ tenantId: T, domainId: null, productId: null })).toBe(false);
  });

  it("hands the service the second filter that keeps the owners' e-mail addresses to the requests the caller may DECIDE (a steward or above over the entity): KD-023", async () => {
    signInAs(principalOf([assign.domain("STEWARD", T, "dom-a"), assign.domain("VIEWER", T, "dom-b"), assign.tenant("VIEWER", T)]));
    await getGovernanceRequestsAction();
    const mayDecide = h.getAllRequests.mock.calls[0][2] as (place: { tenantId: string; domainId: string | null; productId: string | null }) => boolean;
    expect(mayDecide({ tenantId: T, domainId: "dom-a", productId: "prod-a" })).toBe(true);
    // a viewer (of the tenant, or of that domain) reads the request, and is not told whom it affects
    expect(mayDecide({ tenantId: T, domainId: "dom-b", productId: null })).toBe(false);
    expect(mayDecide({ tenantId: T, domainId: "dom-c", productId: null })).toBe(false);
    expect(mayDecide({ tenantId: T, domainId: null, productId: null })).toBe(false);
  });
});

describe("getEntitiesForRetentionAction", () => {
  const where = () => h.findManyEntities.mock.calls[0][0].where as Record<string, unknown>;

  it("answers nobody signed in and a user with no role without reading anything", async () => {
    signedOut();
    expect(await getEntitiesForRetentionAction()).toEqual({ error: "Not authenticated", entities: [] });
    signInAs(roleless());
    expect(await getEntitiesForRetentionAction()).toEqual({ error: "Entities not found", entities: [] });
    expect(h.findManyEntities).not.toHaveBeenCalled();
  });

  it("is open to every role of the ladder and reads only the ACTIVE tenant's entities, all of them for a tenant-wide role", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      h.findManyEntities.mockResolvedValue([]);
      expect(await getEntitiesForRetentionAction(), role).toEqual({ entities: [] });
      expect(where(), role).toEqual({ tenantId: T });
    }
  });

  it("a platform administrator reads the tenant in view, nothing else", async () => {
    signInAs(principalOf([assign.global()]));
    await getEntitiesForRetentionAction();
    expect(where()).toEqual({ tenantId: T });
  });

  it("a domain- or product-scoped role reads only the entities under its domains and products, in the query (never a tenant-level entity)", async () => {
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a"), assign.product("AUTHOR", T, "dom-b", "prod-x"), assign.domain("ADMIN", OTHER, "dom-z")]));
    await getEntitiesForRetentionAction();
    expect(where()).toEqual({ tenantId: T, OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] });
  });

  it("a role in another tenant than the one in view reads nothing", async () => {
    signInAs(tenantMember("ADMIN", OTHER));
    expect(await getEntitiesForRetentionAction()).toEqual({ error: "Entities not found", entities: [] });
    expect(h.findManyEntities).not.toHaveBeenCalled();
  });

  it("KD-046: each row's metadata keeps the retention policy and drops the stored generated schemas (the files of whole closures)", async () => {
    signInAs(tenantMember("VIEWER", T));
    h.activeTenant.mockResolvedValue(T);
    h.findManyEntities.mockResolvedValue([
      { id: "e1", name: "Order", domain: { name: "Sales" }, fields: [], metadata: { retentionPolicy: { days: 30 }, schemaVersions: { avro: [{ output: "iban" }] } } },
    ]);
    const answer = (await getEntitiesForRetentionAction()) as { entities: Array<{ metadata: unknown }> };
    expect(answer.entities[0].metadata).toEqual({ retentionPolicy: { days: 30 } });
    expect(JSON.stringify(answer)).not.toContain("iban");
  });
});

describe("updateRetentionPolicyAction", () => {
  it("checks the payload only after the guard: nobody learns what a valid policy looks like without a role over the entity", async () => {
    signInAs(roleless());
    expect(await updateRetentionPolicyAction("ent-1", { nonsense: true })).toEqual({ error: "Entity not found", code: "NOT_FOUND" });
    signInAs(tenantMember("AUTHOR", T));
    expect(await updateRetentionPolicyAction("ent-1", { nonsense: true })).toEqual({ error: GENERIC_FORBIDDEN, code: "FORBIDDEN" });
    signInAs(tenantMember("STEWARD", T));
    expect(await updateRetentionPolicyAction("ent-1", { nonsense: true })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.updateEntity).not.toHaveBeenCalled();
  });
});
