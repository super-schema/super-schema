/**
 * `experimental.staleTimes.dynamic = 30` serves /schemas from the client router
 * cache; only a revalidating server action evicts it. Every server action that
 * mutates data those pages render must therefore call revalidatePath on success
 * (and only on success).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, principalOf } from "../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  assignRole: vi.fn(),
  removeRole: vi.fn(),
  updateUser: vi.fn(),
  updateEmitterConfig: vi.fn(),
  createDomainAdmin: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  createGlobalOverride: vi.fn(),
  createEntityOverride: vi.fn(),
  acknowledgeLossyMapping: vi.fn(),
  guardSubject: vi.fn(),
  guardActiveTenant: vi.fn(),
  authorizeSubject: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
// The governance actions read the tenant being viewed (a cookie): here there is none.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: vi.fn(async () => "tenant-a") }));
// The guards in front of the entity actions (the real ones are tested in tests/unit/app/by-id-entity-actions-tenant.test.ts and
// entity-area-access.test.ts): here they let a global administrator through.
vi.mock("@/lib/action-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/action-context")>()),
  guardSubject: mocks.guardSubject,
  guardActiveTenant: mocks.guardActiveTenant,
  authorizeSubject: mocks.authorizeSubject,
}));
vi.mock("@/services/rbac.service", () => ({
  getEffectiveRole: mocks.getEffectiveRole,
  assignRole: mocks.assignRole,
  removeRole: mocks.removeRole,
}));
vi.mock("@/services/user.service", () => ({
  updateUser: mocks.updateUser,
}));
vi.mock("@/services/health.service", () => ({
  runHealthCheck: vi.fn(),
  getUsageMetrics: vi.fn(),
  getActivityMetrics: vi.fn(),
  getErrorSummary: vi.fn(),
}));
vi.mock("@/services/emitter-config.service", () => ({
  getEmitterConfigs: vi.fn(),
  updateEmitterConfig: mocks.updateEmitterConfig,
}));
vi.mock("@/services/domain-admin.service", () => ({
  getDomainsAdmin: vi.fn(),
  createDomainAdmin: mocks.createDomainAdmin,
}));
vi.mock("@/services/governance.service", () => ({
  getAllRequests: vi.fn(),
  approveRequest: mocks.approveRequest,
  rejectRequest: mocks.rejectRequest,
}));
vi.mock("@/services/type-mapping.service", () => ({
  createGlobalOverride: mocks.createGlobalOverride,
  createEntityOverride: mocks.createEntityOverride,
  acknowledgeLossyMapping: mocks.acknowledgeLossyMapping,
}));

import {
  assignRoleAction,
  createDomainAdminAction,
  removeRoleAction,
  updateEmitterConfigAction,
  updateUserNameAction,
} from "@/app/(dashboard)/admin/actions";
import {
  approveGovernanceRequestAction,
  rejectGovernanceRequestAction,
} from "@/app/(dashboard)/governance/actions";
import {
  acknowledgeLossyMappingAction,
  createTypeMappingOverrideAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";

const OK = { success: true, data: { id: "x" } };
const FAIL = { success: false, error: { code: "FORBIDDEN", message: "nope" } };

const OVERRIDE_INPUT = {
  sourceType: "string",
  targetFormat: "avro",
  mappedType: "string",
  justification: "because",
  entityId: "ent-1",
  isLossy: false,
};

// One row per mutating action: how to call it and which service decides its outcome.
const ACTIONS: Array<{
  name: string;
  service: keyof typeof mocks;
  call: () => Promise<unknown>;
  paths: Array<[string, string]>;
}> = [
  { name: "assignRoleAction", service: "assignRole", call: () => assignRoleAction({} as never), paths: [["/schemas", "layout"]] },
  { name: "removeRoleAction", service: "removeRole", call: () => removeRoleAction("role-1"), paths: [["/schemas", "layout"]] },
  { name: "createDomainAdminAction", service: "createDomainAdmin", call: () => createDomainAdminAction({} as never), paths: [["/schemas", "layout"]] },
  { name: "updateEmitterConfigAction", service: "updateEmitterConfig", call: () => updateEmitterConfigAction({} as never), paths: [["/schemas", "layout"]] },
  { name: "updateUserNameAction", service: "updateUser", call: () => updateUserNameAction("u1", "New Name"), paths: [["/schemas", "layout"]] },
  {
    name: "approveGovernanceRequestAction",
    service: "approveRequest",
    call: () => approveGovernanceRequestAction("req-1", null),
    paths: [["/schemas", "layout"], ["/governance", "layout"]],
  },
  {
    name: "rejectGovernanceRequestAction",
    service: "rejectRequest",
    call: () => rejectGovernanceRequestAction("req-1", null),
    paths: [["/schemas", "layout"], ["/governance", "layout"]],
  },
  {
    name: "createTypeMappingOverrideAction (global)",
    service: "createGlobalOverride",
    call: () => createTypeMappingOverrideAction({ ...OVERRIDE_INPUT, scope: "global" }),
    paths: [["/schemas", "layout"]],
  },
  {
    name: "createTypeMappingOverrideAction (per-entity)",
    service: "createEntityOverride",
    call: () => createTypeMappingOverrideAction({ ...OVERRIDE_INPUT, scope: "per-entity" }),
    paths: [["/schemas", "layout"]],
  },
  {
    name: "acknowledgeLossyMappingAction",
    service: "acknowledgeLossyMapping",
    call: () => acknowledgeLossyMappingAction({ entityId: "ent-1", sourceType: "string", targetFormat: "avro" }),
    paths: [["/schemas", "layout"]],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } });
  mocks.getEffectiveRole.mockResolvedValue({ success: true, data: "ADMIN" });
  const allowed = { allowed: true as const, principal: principalOf([assign.global()], { userId: "user-1" }), resource: { tenantId: "tenant-a" } };
  mocks.guardSubject.mockResolvedValue(allowed);
  mocks.guardActiveTenant.mockResolvedValue(allowed);
  mocks.authorizeSubject.mockResolvedValue({ success: true, data: { principal: allowed.principal, resource: allowed.resource } });
  for (const { service } of ACTIONS) mocks[service].mockResolvedValue(OK);
});

describe.each(ACTIONS)("$name", ({ service, call, paths }) => {
  it("revalidates after a successful mutation", async () => {
    await call();
    expect(mocks[service]).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath.mock.calls).toEqual(paths);
  });

  it("does not revalidate when the service rejects the mutation", async () => {
    mocks[service].mockResolvedValue(FAIL);
    const result = (await call()) as { error?: string };
    expect(result.error).toBe("nope");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not revalidate (or mutate) when unauthenticated", async () => {
    mocks.auth.mockResolvedValue(null);
    // The entity actions' guards are replaced here (they answer this themselves: tests/unit/app/entity-area-access.test.ts): nobody is refused.
    const nobody = { allowed: false as const, refusal: { error: "Not authenticated", code: "UNAUTHORIZED" as const } };
    mocks.guardSubject.mockResolvedValue(nobody);
    mocks.guardActiveTenant.mockResolvedValue(nobody);
    mocks.authorizeSubject.mockResolvedValue({ success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    const result = (await call()) as { error?: string };
    expect(result.error).toBe("Not authenticated");
    expect(mocks[service]).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
