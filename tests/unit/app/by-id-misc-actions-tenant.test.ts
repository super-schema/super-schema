import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, resetSessionPrincipal, setSessionPrincipal } from "../../helpers/access-mocks";

// Tenant scoping + generic failures of the remaining by-id actions outside the entity workspace file: the entity publish /
// version actions, the retention policy action and the domain delete. (Product actions: product-action-tenant-guard.test.ts.)

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getActiveTenantId: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  previewPublish: vi.fn(),
  publishEntity: vi.fn(),
  listEntityVersions: vi.fn(),
  resolveGlobalAdminAccess: vi.fn(),
  prisma: {
    entity: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    domain: { findUnique: vi.fn(), delete: vi.fn() },
    messageVersion: { findMany: vi.fn() },
    channel: { findMany: vi.fn() },
    trait: { findMany: vi.fn() },
    schemaReference: { findMany: vi.fn() },
    eventSpecVersion: { findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: h.prisma }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/access-control", () => ({ resolveGlobalAdminAccess: h.resolveGlobalAdminAccess }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/services/entity-version.service", () => ({
  previewPublish: h.previewPublish,
  publishEntity: h.publishEntity,
  listEntityVersions: h.listEntityVersions,
}));

import {
  getPublishPreviewAction,
  listEntityVersionsAction,
  publishEntityAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";
import { getEntitiesForRetentionAction, updateRetentionPolicyAction } from "@/app/(dashboard)/governance/retention/actions";
import { createDomainAction, deleteDomainAction } from "@/app/(dashboard)/schemas/actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const T = "tenant-1";
const OTHER = "tenant-2";
const asAny = (v: unknown) => v as never;
type Mock = ReturnType<typeof vi.fn>;
const mk = (fn: unknown) => fn as Mock;
const p = h.prisma;

const PRISMA_TEXT =
  "Invalid `prisma.entity.update()` invocation in\n/Users/dev/src/my/super-schema/src/app/(dashboard)/governance/retention/actions.ts:60:18\n\n→ 60 prisma.entity.update({ data: { metadata: undefined\nArgument `metadata` is missing.";
const LEAKS = /prisma|Users\/dev|actions\.ts|invocation|Argument|undefined|Cannot read properties|TypeError/i;
const NOT_FOUND = { error: "Entity not found", code: "NOT_FOUND" };
const SUMMARY = { id: "v1", label: "1.0" };

const EMPTY_COUNTS = {
  entities: 0, products: 0, modelDefinitions: 0, decoratorDefinitions: 0, sharedEnums: 0, customScalars: 0, unionTypes: 0, services: 0,
  interfaces: 0, userRoles: 0, channels: 0, messages: 0, traits: 0, eventSpecs: 0,
};
const domainRow = (tenantId: string) => ({ id: "dom-1", tenantId, name: "Orders", isSystem: false, _count: EMPTY_COUNTS });

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionPrincipal();
  h.auth.mockResolvedValue({ user: { id: "user-1", email: "u@example.test" } });
  h.getActiveTenantId.mockResolvedValue(T);
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
  h.resolveGlobalAdminAccess.mockResolvedValue({ userId: "user-1", isAdmin: true });
  h.previewPublish.mockResolvedValue({ success: true, data: { isFirstPublish: true } });
  h.publishEntity.mockResolvedValue({ success: true, data: SUMMARY });
  h.listEntityVersions.mockResolvedValue({ success: true, data: [SUMMARY] });
  p.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: T, metadata: { tags: ["a"] } });
  p.entity.update.mockResolvedValue({ id: "ent-1" });
  p.domain.findUnique.mockResolvedValue(domainRow(T));
  p.domain.delete.mockResolvedValue({ id: "dom-1" });
  p.auditLog.create.mockResolvedValue({ id: "audit-1" });
  p.user.findUnique.mockResolvedValue({ id: "user-1" });
  for (const kind of [p.messageVersion, p.channel, p.trait, p.schemaReference, p.eventSpecVersion]) kind.findMany.mockResolvedValue([]);
});

describe.each([
  { label: "getPublishPreviewAction", call: () => getPublishPreviewAction("ent-1"), service: () => mk(h.previewPublish) },
  { label: "publishEntityAction", call: () => publishEntityAction("ent-1", {}), service: () => mk(h.publishEntity) },
  { label: "listEntityVersionsAction", call: () => listEntityVersionsAction("ent-1"), service: () => mk(h.listEntityVersions) },
])("$label", ({ call, service }) => {
  it("works on an entity of the active tenant", async () => {
    expect(await call()).toMatchObject({ success: true });
    expect(service()).toHaveBeenCalledTimes(1);
  });

  it("answers an entity of ANOTHER tenant exactly like a missing one and never reaches the service (nothing is previewed, listed or published)", async () => {
    p.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: OTHER });
    const foreign = await call();
    p.entity.findUnique.mockResolvedValue(null);
    const missing = await call();
    expect(foreign).toEqual(NOT_FOUND);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(service()).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns the generic message when the service throws a Prisma error with a path and a source excerpt", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    service().mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await call();
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    spy.mockRestore();
  });

  it("turns a DB_ERROR / INTERNAL_ERROR Result into the generic message, keeps other failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    service().mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: "connect ECONNREFUSED 10.0.0.5:5432" } });
    expect(await call()).toEqual({ error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    service().mockResolvedValue({ success: false, error: { code: "PUBLISH_BLOCKED", message: "Publish Customer first" } });
    expect(await call()).toEqual({ error: "Publish Customer first", code: "PUBLISH_BLOCKED" });
    spy.mockRestore();
  });

  it("requires a session before any query", async () => {
    h.auth.mockResolvedValue(null);
    expect(await call()).toEqual({ error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(p.entity.findUnique).not.toHaveBeenCalled();
  });
});

describe("publishEntityAction input", () => {
  it("a null / non-object input is treated as no options instead of throwing", async () => {
    expect(await publishEntityAction("ent-1", asAny(null))).toMatchObject({ success: true });
    expect(h.publishEntity).toHaveBeenCalledWith("ent-1", { bump: undefined, changeSummary: undefined }, expect.anything());
  });
});

describe("updateRetentionPolicyAction", () => {
  const retention = (policy: unknown) => updateRetentionPolicyAction("ent-1", asAny(policy));

  it("writes the policy of an entity of the active tenant", async () => {
    expect(await retention({ strategy: "age-based", period: 1, periodUnit: "years", action: "delete" })).toEqual({ success: true });
    expect(p.entity.update).toHaveBeenCalledTimes(1);
  });

  it("answers an entity of ANOTHER tenant exactly like a missing one and writes nothing", async () => {
    p.entity.findUnique.mockResolvedValue({ id: "ent-1", tenantId: OTHER, metadata: {} });
    const foreign = await retention({ strategy: "age-based", period: 1, periodUnit: "years", action: "delete" });
    p.entity.findUnique.mockResolvedValue(null);
    const missing = await retention({ strategy: "age-based", period: 1, periodUnit: "years", action: "delete" });
    expect(foreign).toEqual(NOT_FOUND);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(p.entity.update).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a policy that is not a plain object (a Date / Map / array would still mark the draft changed)", async () => {
    for (const bad of [new Date(), new Map(), [], null, undefined, "P1Y", 5]) {
      expect(await retention(bad)).toEqual({ error: "The retention policy must be an object", code: "VALIDATION_ERROR" });
    }
    // The guard reads the entity's place first (one look-up, nothing else): the payload is only checked after it, and nothing is written.
    expect(p.entity.findUnique).toHaveBeenCalledTimes(7);
    expect(p.entity.update).not.toHaveBeenCalled();
  });

  it("returns the generic message, never the Prisma text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    p.entity.update.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await retention({ strategy: "age-based", period: 1, periodUnit: "years", action: "delete" });
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    spy.mockRestore();
  });
});

describe("getEntitiesForRetentionAction lists the ACTIVE tenant's entities (the write is scoped, so the list is too)", () => {
  const row = (id: string) => ({ id, name: id, metadata: { retentionPolicy: { period: "P1Y" } }, domain: null, fields: [{ name: "email", type: "string", classification: "PII" }] });

  it("filters by the active tenant and maps the rows (Enterprise, domain and product entities all carry their tenant)", async () => {
    p.entity.findMany.mockResolvedValue([row("ent-1"), row("ent-2")]);
    const result = (await getEntitiesForRetentionAction()) as { entities: Array<{ id: string }>; error?: string };
    expect(result.error).toBeUndefined();
    expect(result.entities.map((e) => e.id)).toEqual(["ent-1", "ent-2"]);
    expect(p.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: T } }));
  });

  it("follows the active tenant", async () => {
    p.entity.findMany.mockResolvedValue([]);
    h.getActiveTenantId.mockResolvedValue(OTHER);
    await getEntitiesForRetentionAction();
    expect(p.entity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: OTHER } }));
  });

  it("requires a session before any query", async () => {
    h.auth.mockResolvedValue(null);
    expect(await getEntitiesForRetentionAction()).toEqual({ error: "Not authenticated", entities: [] });
    expect(p.entity.findMany).not.toHaveBeenCalled();
  });

  it("a failing query is the generic message (logged), keeping the empty list the page expects; control flow is re-thrown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    p.entity.findMany.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await getEntitiesForRetentionAction();
    expect(result).toMatchObject({ error: GENERIC_ACTION_ERROR, entities: [] });
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/schemas;307;" });
    p.entity.findMany.mockRejectedValue(redirect);
    await expect(getEntitiesForRetentionAction()).rejects.toBe(redirect);
    spy.mockRestore();
  });
});

describe("deleteDomainAction tenant guard", () => {
  it("deletes an empty domain of the active tenant", async () => {
    expect(await deleteDomainAction("dom-1")).toEqual({ success: true });
    expect(p.domain.delete).toHaveBeenCalledWith({ where: { id: "dom-1" } });
  });

  it("answers a domain of ANOTHER tenant exactly like a missing one; nothing is deleted or audited (an admin of tenant A cannot drop tenant B's domain)", async () => {
    p.domain.findUnique.mockResolvedValue(domainRow(OTHER));
    const foreign = await deleteDomainAction("dom-1");
    p.domain.findUnique.mockResolvedValue(null);
    const missing = await deleteDomainAction("dom-1");
    expect(foreign).toEqual({ error: "Domain not found" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(p.domain.delete).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("asks the policy before anything is deleted: a user below tenant administrator is refused, generic, and nothing is audited", async () => {
    setSessionPrincipal([assign.tenant("STEWARD", T)]);
    expect(await deleteDomainAction("dom-1")).toEqual({ error: "You do not have permission to do this" });
    setSessionPrincipal([assign.tenant("ADMIN", T)]);
    expect(await deleteDomainAction("dom-1")).toEqual({ success: true });
    expect(p.domain.delete).toHaveBeenCalledTimes(1);
  });

  it("returns the generic message (not the driver text) when the delete throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    p.domain.delete.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await deleteDomainAction("dom-1");
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    spy.mockRestore();
  });
});

describe("createDomainAction failures", () => {
  it("returns the generic message, not the driver text, for an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fd = new FormData();
    fd.set("name", "Payments");
    // withAudit -> the audit user lookup throws a Prisma-like error
    p.user.findUnique.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = await createDomainAction(fd);
    expect(result).toEqual({ error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    spy.mockRestore();
  });
});
