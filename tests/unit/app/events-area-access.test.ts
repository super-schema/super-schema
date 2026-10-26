// @vitest-environment node
/**
 * Access control over the Events area: the product-addressed event actions, the library trait actions and the usage lookup. The REAL guard
 * runs; what is replaced is the database look-ups and the services behind the actions, which are the "effects" a refused caller must never reach.
 *
 * The table: reading an event (and everything that only reads: emission, versions, the publish preview, the external-reference loaders) is a
 * VIEWER's act over the event's product (`event.read`); editing, renaming, deleting and previewing an unsaved document is an AUTHOR's
 * (`event.write`), as is pinning a schema (`event.pin`) and importing an AsyncAPI document (`import.run`); publishing is a STEWARD's
 * (`event.publish`); traits are an AUTHOR's over their owner (`trait.write`); "who uses X" is a VIEWER's over the subject (`usage.read`).
 * For each operation: nobody signed in, a user with no role, every role of the ladder, a product of another tenant (also for a user who holds
 * a role there: it is not the tenant in view), domain-scoped and product-scoped holders on the right and on the wrong scope.
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
    findProduct: fn(), findDomain: fn(), findTenant: fn(), findEntity: fn(), findEvent: fn(),
    createEvent: fn(), updateEventDocument: fn(), renameEvent: fn(), deleteEvent: fn(),
    emitEventDocumentPreview: fn(), emitEventDraft: fn(), emitEventStoredVersion: fn(),
    previewEventPublish: fn(), publishEvent: fn(), listEventVersions: fn(),
    requireOwnedEvent: fn(), listExternalEventCandidates: fn(), listExternalEventVersions: fn(), getExternalVersionItems: fn(), getExternalRefStatuses: fn(),
    renderPinJsonSchema: fn(), createTrait: fn(), updateTrait: fn(), deleteTrait: fn(),
    previewAsyncApiImport: fn(), importAsyncApi: fn(), findUsages: fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.activeTenant }));
vi.mock("@/lib/db", () => ({
  prisma: {
    tag: "prisma",
    product: { findUnique: h.findProduct }, domain: { findUnique: h.findDomain }, tenant: { findUnique: h.findTenant },
    entity: { findUnique: h.findEntity }, eventSpec: { findUnique: h.findEvent },
  },
}));
vi.mock("@/services/events/event.service", () => ({ createEvent: h.createEvent, updateEventDocument: h.updateEventDocument, renameEvent: h.renameEvent, deleteEvent: h.deleteEvent }));
vi.mock("@/services/events/event-emit.service", () => ({ emitEventDocumentPreview: h.emitEventDocumentPreview, emitEventDraft: h.emitEventDraft, emitEventStoredVersion: h.emitEventStoredVersion }));
vi.mock("@/services/events/event-publish.service", () => ({ previewEventPublish: h.previewEventPublish, publishEvent: h.publishEvent, listEventVersions: h.listEventVersions }));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));
vi.mock("@/services/events/asyncapi-import.service", () => ({ previewAsyncApiImport: h.previewAsyncApiImport, importAsyncApi: h.importAsyncApi }));
vi.mock("@/services/events/external-refs.service", () => ({
  listExternalEventCandidates: h.listExternalEventCandidates, listExternalEventVersions: h.listExternalEventVersions,
  getExternalVersionItems: h.getExternalVersionItems, getExternalRefStatuses: h.getExternalRefStatuses,
}));
vi.mock("@/services/events/pin-json-schema.service", () => ({ renderPinJsonSchema: h.renderPinJsonSchema }));
vi.mock("@/services/events/usage.service", () => ({ findUsages: h.findUsages }));
vi.mock("@/services/events/service-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events/service-guards")>()),
  requireOwnedEvent: h.requireOwnedEvent,
}));

import * as eventActions from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { createTraitAction, deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { listUsagesAction } from "@/app/(dashboard)/schemas/usage-actions";
import { usageRowList } from "@/lib/events/usage";

const GENERIC_FORBIDDEN = { success: false, error: "You do not have permission to do this", code: "FORBIDDEN" };
const SERVICES = [
  h.createEvent, h.updateEventDocument, h.renameEvent, h.deleteEvent, h.emitEventDocumentPreview, h.emitEventDraft, h.emitEventStoredVersion,
  h.previewEventPublish, h.publishEvent, h.listEventVersions, h.listExternalEventCandidates, h.listExternalEventVersions, h.getExternalVersionItems,
  h.getExternalRefStatuses, h.renderPinJsonSchema, h.createTrait, h.updateTrait, h.deleteTrait, h.previewAsyncApiImport, h.importAsyncApi, h.findUsages,
  h.revalidatePath,
];
const reached = () => SERVICES.filter((service) => service.mock.calls.length > 0);

/** Where the product `prod-a` (domain `dom-a`), the domain and the pinned entity live. */
function place(tenantId: string, domainId = "dom-a") {
  h.findProduct.mockResolvedValue({ id: "prod-a", domainId, domain: { tenantId } });
  h.findDomain.mockResolvedValue({ id: domainId, tenantId });
  h.findTenant.mockResolvedValue({ id: tenantId });
  const row = { tenantId, domainId, productId: "prod-a", product: { domainId } };
  h.findEntity.mockResolvedValue(row);
  h.findEvent.mockResolvedValue(row);
}

type Op = { label: string; call: () => Promise<unknown>; min: Role };
const IMPORT_INPUT = { content: "asyncapi: 3.0.0\n" };

const OPS: Op[] = [
  { label: "createEventAction", call: () => eventActions.createEventAction("prod-a", { name: "e" }), min: "AUTHOR" },
  { label: "updateEventDocumentAction", call: () => eventActions.updateEventDocumentAction("e1", "prod-a", {}), min: "AUTHOR" },
  { label: "renameEventAction", call: () => eventActions.renameEventAction("e1", "prod-a", "n"), min: "AUTHOR" },
  { label: "deleteEventAction", call: () => eventActions.deleteEventAction("e1", "prod-a"), min: "AUTHOR" },
  { label: "previewEventDocumentAction", call: () => eventActions.previewEventDocumentAction("e1", "prod-a", {}), min: "AUTHOR" },
  { label: "pinJsonSchemaAction", call: () => eventActions.pinJsonSchemaAction("prod-a", { entityId: "ent-1", entityVersionId: null }), min: "AUTHOR" },
  { label: "previewAsyncApiImportAction", call: () => eventActions.previewAsyncApiImportAction("prod-a", IMPORT_INPUT), min: "AUTHOR" },
  { label: "importAsyncApiAction", call: () => eventActions.importAsyncApiAction("prod-a", IMPORT_INPUT), min: "AUTHOR" },
  { label: "publishEventAction", call: () => eventActions.publishEventAction("e1", "prod-a", { bump: "MINOR" } as never), min: "STEWARD" },
  { label: "emitEventDraftAction", call: () => eventActions.emitEventDraftAction("e1", "prod-a"), min: "VIEWER" },
  { label: "previewEventPublishAction", call: () => eventActions.previewEventPublishAction("e1", "prod-a"), min: "VIEWER" },
  { label: "listEventVersionsAction", call: () => eventActions.listEventVersionsAction("e1", "prod-a"), min: "VIEWER" },
  { label: "readEventVersionAction", call: () => eventActions.readEventVersionAction("e1", "prod-a", "1.0"), min: "VIEWER" },
  { label: "listExternalEventCandidatesAction", call: () => eventActions.listExternalEventCandidatesAction("prod-a", "e1", "ord"), min: "VIEWER" },
  { label: "listExternalEventVersionsAction", call: () => eventActions.listExternalEventVersionsAction("prod-a", "src1"), min: "VIEWER" },
  { label: "getExternalVersionItemsAction", call: () => eventActions.getExternalVersionItemsAction("prod-a", "v1"), min: "VIEWER" },
  { label: "getExternalRefStatusesAction", call: () => eventActions.getExternalRefStatusesAction("prod-a", []), min: "VIEWER" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  signInAs(tenantMember("ADMIN", T));
  h.activeTenant.mockResolvedValue(T);
  place(T);
  for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
  h.requireOwnedEvent.mockResolvedValue({ success: true, data: "e1" });
  h.findUsages.mockResolvedValue({ success: true, data: usageRowList([], false) });
});

const code = (answer: unknown) => (answer as { code?: string }).code;
const ok = (answer: unknown) => (answer as { success?: boolean }).success === true;

describe.each(OPS)("$label", (op) => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing, not even a look-up", async () => {
    signedOut();
    expect(await op.call()).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(reached()).toHaveLength(0);
    expect(h.findProduct).not.toHaveBeenCalled();
  });

  it("answers a user with no role at all as a missing product and reaches nothing", async () => {
    signInAs(roleless());
    expect(await op.call()).toEqual({ success: false, error: 'Product "prod-a" not found', code: "NOT_FOUND" });
    expect(reached()).toHaveLength(0);
  });

  it("is allowed from its minimum role up and refused (generic, nothing reached) below it", async () => {
    for (const role of ROLE_HIERARCHY) {
      vi.clearAllMocks();
      signInAs(tenantMember(role, T));
      h.activeTenant.mockResolvedValue(T);
      place(T);
      for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
      h.requireOwnedEvent.mockResolvedValue({ success: true, data: "e1" });
      const answer = await op.call();
      if (roleAtLeast(role, op.min)) {
        expect(ok(answer), `${role}: ${JSON.stringify(answer)}`).toBe(true);
      } else {
        expect(answer, role).toEqual(GENERIC_FORBIDDEN);
        expect(reached(), `${role} reached an effect`).toHaveLength(0);
      }
    }
  });

  it("answers a product of ANOTHER tenant exactly as a missing one, even for an administrator of both tenants, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    place(OTHER);
    const foreign = await op.call();
    h.findProduct.mockResolvedValue(null);
    const missing = await op.call();
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(code(foreign)).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("follows the ACTIVE tenant: a role in the product's tenant does not help while another tenant is in view", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.activeTenant.mockResolvedValue(OTHER);
    expect(code(await op.call())).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("a domain-scoped role takes effect: the right domain may, a sibling domain reads the product as missing, too low a role there is refused", async () => {
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-a")]));
    expect(ok(await op.call())).toBe(true);
    signInAs(principalOf([assign.domain(op.min === "VIEWER" ? "VIEWER" : "AUTHOR", T, "dom-a")]));
    const own = await op.call();
    expect(ok(own) || JSON.stringify(own) === JSON.stringify(GENERIC_FORBIDDEN)).toBe(true);
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
    expect(code(await op.call())).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("a product-scoped role takes effect: its own product may, a sibling product reads as missing", async () => {
    signInAs(principalOf([assign.product("ADMIN", T, "dom-a", "prod-a")]));
    expect(ok(await op.call())).toBe(true);
    vi.clearAllMocks();
    signInAs(principalOf([assign.product("ADMIN", T, "dom-a", "prod-b")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    for (const service of SERVICES) service.mockResolvedValue({ success: true, data: { id: "x" } });
    expect(code(await op.call())).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });
});

describe("a malformed product id", () => {
  it("is answered as a missing product by every product-addressed action, with no look-up and no effect", async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => eventActions.createEventAction(5 as never, { name: "e" }),
      () => eventActions.publishEventAction("e1", null as never, {} as never),
      () => eventActions.listEventVersionsAction("e1", undefined as never),
      () => eventActions.listExternalEventCandidatesAction({} as never, "e1"),
      () => eventActions.pinJsonSchemaAction("" as never, { entityId: "ent-1", entityVersionId: null }),
    ];
    for (const call of calls) expect(await call()).toEqual({ success: false, error: 'Product "" not found', code: "NOT_FOUND" });
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(reached()).toHaveLength(0);
  });
});

describe("the tenant-wide external-reference loaders", () => {
  const candidatesRestriction = async () => {
    await eventActions.listExternalEventCandidatesAction("prod-a", "e1", "ord");
    return (h.listExternalEventCandidates.mock.calls[0]?.[1] ?? {}) as { restrictTo?: unknown; tenantId?: string };
  };

  it("are unrestricted for a role over the whole tenant and carry the ACTIVE tenant the guard proved, never the client's", async () => {
    signInAs(tenantMember("VIEWER", T));
    expect(await candidatesRestriction()).toEqual({ tenantId: T, excludeEventId: "e1", query: "ord", restrictTo: undefined });
  });

  it("are restricted to the domains and products the caller's roles reach, in the query (a sibling domain's events are not offered)", async () => {
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a"), assign.product("AUTHOR", T, "dom-b", "prod-x")]));
    const call = await candidatesRestriction();
    expect(call.restrictTo).toEqual({ domainIds: ["dom-a"], productIds: ["prod-x"] });
    // the same restriction reaches the three by-id loaders
    await eventActions.listExternalEventVersionsAction("prod-a", "src1");
    await eventActions.getExternalVersionItemsAction("prod-a", "v1");
    await eventActions.getExternalRefStatusesAction("prod-a", []);
    for (const loader of [h.listExternalEventVersions, h.getExternalVersionItems, h.getExternalRefStatuses]) {
      expect((loader.mock.calls[0][1] as { restrictTo: unknown }).restrictTo).toEqual({ domainIds: ["dom-a"], productIds: ["prod-x"] });
    }
  });

  it("a role of another tenant adds nothing to the restriction", async () => {
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a"), assign.domain("ADMIN", OTHER, "dom-z")]));
    expect((await candidatesRestriction()).restrictTo).toEqual({ domainIds: ["dom-a"], productIds: [] });
  });
});

describe("pinJsonSchemaAction reads the pinned ENTITY too", () => {
  it("refuses (the service's own NOT_FOUND text, the service never runs) a pin of an entity the caller's roles do not cover, though the product is theirs", async () => {
    signInAs(principalOf([assign.product("AUTHOR", T, "dom-a", "prod-a")]));
    h.findEntity.mockResolvedValue({ tenantId: T, domainId: "dom-b", productId: "prod-b", product: { domainId: "dom-b" } });
    expect(await eventActions.pinJsonSchemaAction("prod-a", { entityId: "ent-1", entityVersionId: null })).toEqual({
      success: false, error: 'Entity "ent-1" not found', code: "NOT_FOUND",
    });
    h.findEntity.mockResolvedValue(null);
    expect(await eventActions.pinJsonSchemaAction("prod-a", { entityId: "ent-1", entityVersionId: null })).toEqual({
      success: false, error: 'Entity "ent-1" not found', code: "NOT_FOUND",
    });
    expect(h.renderPinJsonSchema).not.toHaveBeenCalled();
  });

  it("an entity of another tenant reads the same, even for a user who holds a role there", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    h.findEntity.mockResolvedValue({ tenantId: OTHER, domainId: "dom-a", productId: "prod-a", product: { domainId: "dom-a" } });
    expect(code(await eventActions.pinJsonSchemaAction("prod-a", { entityId: "ent-1", entityVersionId: null }))).toBe("NOT_FOUND");
    expect(h.renderPinJsonSchema).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Library traits: an author's act over the OWNER (the tenant, a domain or a product)
// ---------------------------------------------------------------------------------------------------------------------------------

type Target = { level: "TENANT"; tenantId: string } | { level: "DOMAIN"; domainId: string } | { level: "PRODUCT"; productId: string };
const TRAIT_OPS: Array<{ label: string; call: (target: Target) => Promise<unknown>; service: () => ReturnType<typeof vi.fn> }> = [
  { label: "createTraitAction", call: (t) => createTraitAction(t, { name: "CloudEvents", kind: "MESSAGE" }), service: () => h.createTrait },
  { label: "updateTraitAction", call: (t) => updateTraitAction("t1", t, { name: "CloudEvents" }), service: () => h.updateTrait },
  { label: "deleteTraitAction", call: (t) => deleteTraitAction("t1", t), service: () => h.deleteTrait },
];
const TENANT_TARGET: Target = { level: "TENANT", tenantId: "client-says-this" };
const DOMAIN_TARGET: Target = { level: "DOMAIN", domainId: "dom-a" };
const PRODUCT_TARGET: Target = { level: "PRODUCT", productId: "prod-a" };

describe.each(TRAIT_OPS)("$label", ({ call, service }) => {
  it("answers nobody signed in 'Not authenticated' and reaches nothing", async () => {
    signedOut();
    for (const target of [TENANT_TARGET, DOMAIN_TARGET, PRODUCT_TARGET]) {
      expect(await call(target)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    }
    expect(reached()).toHaveLength(0);
  });

  it("answers a user with no role at all as a missing owner and reaches nothing", async () => {
    signInAs(roleless());
    for (const target of [TENANT_TARGET, DOMAIN_TARGET, PRODUCT_TARGET]) expect(code(await call(target)), JSON.stringify(target)).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("is an author's act at every owner level: allowed from AUTHOR up, refused (generic) below, nothing reached", async () => {
    for (const role of ROLE_HIERARCHY) {
      for (const target of [TENANT_TARGET, DOMAIN_TARGET, PRODUCT_TARGET]) {
        vi.clearAllMocks();
        signInAs(tenantMember(role, T));
        h.activeTenant.mockResolvedValue(T);
        place(T);
        for (const s of SERVICES) s.mockResolvedValue({ success: true, data: { id: "x" } });
        const answer = await call(target);
        if (roleAtLeast(role, "AUTHOR")) expect(ok(answer), `${role} ${target.level}: ${JSON.stringify(answer)}`).toBe(true);
        else {
          expect(answer, `${role} ${target.level}`).toEqual(GENERIC_FORBIDDEN);
          expect(reached()).toHaveLength(0);
        }
      }
    }
  });

  it("a TENANT target is always the active tenant (the client's id is ignored) and needs a role over the whole tenant", async () => {
    signInAs(tenantMember("AUTHOR", T));
    await call(TENANT_TARGET);
    const owner = service().mock.calls[0].find((arg) => typeof arg === "object" && arg !== null && "level" in arg);
    expect(owner).toEqual({ level: "TENANT", tenantId: T });
    // a domain-scoped author cannot make or change a tenant-wide trait
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("ADMIN", T, "dom-a")]));
    h.activeTenant.mockResolvedValue(T);
    expect(code(await call(TENANT_TARGET))).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("answers a DOMAIN or PRODUCT owner of ANOTHER tenant as a missing one, even for an administrator of both, and reaches nothing", async () => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    place(OTHER);
    const foreignDomain = await call(DOMAIN_TARGET);
    const foreignProduct = await call(PRODUCT_TARGET);
    h.findDomain.mockResolvedValue(null);
    h.findProduct.mockResolvedValue(null);
    expect(JSON.stringify(foreignDomain)).toBe(JSON.stringify(await call(DOMAIN_TARGET)));
    expect(JSON.stringify(foreignProduct)).toBe(JSON.stringify(await call(PRODUCT_TARGET)));
    expect(code(foreignDomain)).toBe("NOT_FOUND");
    expect(code(foreignProduct)).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);
  });

  it("a domain-scoped author owns its domain's traits and not a sibling domain's; a product-scoped author its product's only", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-a")]));
    expect(ok(await call(DOMAIN_TARGET))).toBe(true);
    expect(ok(await call(PRODUCT_TARGET))).toBe(true);
    vi.clearAllMocks();
    signInAs(principalOf([assign.domain("AUTHOR", T, "dom-b")]));
    h.activeTenant.mockResolvedValue(T);
    place(T);
    expect(code(await call(DOMAIN_TARGET))).toBe("NOT_FOUND");
    expect(code(await call(PRODUCT_TARGET))).toBe("NOT_FOUND");
    expect(reached()).toHaveLength(0);

    signInAs(principalOf([assign.product("AUTHOR", T, "dom-a", "prod-a")]));
    expect(ok(await call(PRODUCT_TARGET))).toBe(true);
    expect(code(await call(DOMAIN_TARGET))).toBe("NOT_FOUND");
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a")]));
    expect(await call(DOMAIN_TARGET)).toEqual(GENERIC_FORBIDDEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// "Who uses X?": a viewer's act over the subject; the referrers are restricted to what the caller may read
// ---------------------------------------------------------------------------------------------------------------------------------

describe("listUsagesAction", () => {
  const SUBJECTS = [
    { label: "an entity", subject: { kind: "entity", entityId: "ent-1" } as const },
    { label: "an event", subject: { kind: "event", eventId: "ev-1" } as const },
  ];

  it.each(SUBJECTS)("answers nobody signed in and a roleless user without reaching the service ($label)", async ({ subject }) => {
    signedOut();
    expect(await listUsagesAction(subject)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    signInAs(roleless());
    expect(await listUsagesAction(subject)).toEqual({ success: false, error: "Not found", code: "NOT_FOUND" });
    expect(h.findUsages).not.toHaveBeenCalled();
  });

  it.each(SUBJECTS)("is open to every role of the ladder over the subject ($label)", async ({ subject }) => {
    for (const role of ROLE_HIERARCHY) {
      signInAs(tenantMember(role, T));
      expect(ok(await listUsagesAction(subject)), role).toBe(true);
    }
    expect(h.findUsages).toHaveBeenCalledTimes(ROLE_HIERARCHY.length);
  });

  it.each(SUBJECTS)("reads a subject of another tenant, a missing one and one outside the caller's domain as the same NOT_FOUND ($label)", async ({ subject }) => {
    signInAs(principalOf([assign.tenant("ADMIN", T), assign.tenant("ADMIN", OTHER)]));
    const row = { tenantId: OTHER, domainId: "dom-a", productId: "prod-a", product: { domainId: "dom-a" } };
    h.findEntity.mockResolvedValue(row);
    h.findEvent.mockResolvedValue(row);
    const foreign = await listUsagesAction(subject);
    h.findEntity.mockResolvedValue(null);
    h.findEvent.mockResolvedValue(null);
    const missing = await listUsagesAction(subject);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(code(foreign)).toBe("NOT_FOUND");

    signInAs(principalOf([assign.domain("ADMIN", T, "dom-b")]));
    place(T, "dom-a");
    expect(code(await listUsagesAction(subject))).toBe("NOT_FOUND");
    expect(h.findUsages).not.toHaveBeenCalled();
  });

  it("a malformed subject is refused with a validation answer only to somebody who holds a role here", async () => {
    signedOut();
    expect(await listUsagesAction(null as never)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    signInAs(roleless());
    expect(await listUsagesAction({ kind: "x" } as never)).toEqual({ success: false, error: "Not found", code: "NOT_FOUND" });
    signInAs(tenantMember("VIEWER", T));
    expect(code(await listUsagesAction({ kind: "x" } as never))).toBe("VALIDATION_ERROR");
    expect(h.findUsages).not.toHaveBeenCalled();
  });

  it("hands the service a referrer filter that names only what the caller's roles cover (entity, event and trait referrers)", async () => {
    signInAs(principalOf([assign.domain("VIEWER", T, "dom-a")]));
    await listUsagesAction({ kind: "entity", entityId: "ent-1" });
    const visible = h.findUsages.mock.calls[0][3] as (kind: "entity" | "event" | "trait", place: { domainId: string | null; productId: string | null }) => boolean;
    for (const kind of ["entity", "event", "trait"] as const) {
      expect(visible(kind, { domainId: "dom-a", productId: "prod-a" }), kind).toBe(true);
      expect(visible(kind, { domainId: "dom-a", productId: null }), kind).toBe(true);
      expect(visible(kind, { domainId: "dom-b", productId: "prod-b" }), kind).toBe(false);
      expect(visible(kind, { domainId: null, productId: null }), `${kind} tenant-level`).toBe(false);
    }
  });
});
