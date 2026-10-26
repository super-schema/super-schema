import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSessionPrincipal } from "../../helpers/access-mocks";

// The Events create / update / delete / preview / emit actions (the self-contained Event, and library traits) take a CLIENT-supplied
// product (or owner target) and their services only compare the row against that owner, so a foreign product id would be
// self-consistent (`createEventAction("pB", ...)` creating in tenant B). Each requires the PARENT to lie in the ACTIVE tenant
// (`withOwnedTarget`, the REAL one here) and answers a foreign parent with exactly the NOT_FOUND `resolveScope` gives an unknown
// one, without starting the service. The services stay untouched behind it.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  findEntity: vi.fn(),
  findDomain: vi.fn(),
  findProduct: vi.fn(),
  findTenant: vi.fn(),
  createEvent: vi.fn(), updateEventDocument: vi.fn(), renameEvent: vi.fn(), deleteEvent: vi.fn(),
  emitEventDocumentPreview: vi.fn(), emitEventDraft: vi.fn(), emitEventStoredVersion: vi.fn(),
  previewEventPublish: vi.fn(), publishEvent: vi.fn(), listEventVersions: vi.fn(),
  requireOwnedEvent: vi.fn(), listExternalEventCandidates: vi.fn(), listExternalEventVersions: vi.fn(), getExternalVersionItems: vi.fn(), getExternalRefStatuses: vi.fn(),
  renderPinJsonSchema: vi.fn(),
  createTrait: vi.fn(), updateTrait: vi.fn(), deleteTrait: vi.fn(),
  previewAsyncApiImport: vi.fn(), importAsyncApi: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { tag: "prisma", domain: { findUnique: h.findDomain }, product: { findUnique: h.findProduct }, tenant: { findUnique: h.findTenant }, entity: { findUnique: h.findEntity } },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/services/events/event.service", () => ({
  createEvent: h.createEvent, updateEventDocument: h.updateEventDocument, renameEvent: h.renameEvent, deleteEvent: h.deleteEvent,
}));
vi.mock("@/services/events/event-emit.service", () => ({
  emitEventDocumentPreview: h.emitEventDocumentPreview, emitEventDraft: h.emitEventDraft, emitEventStoredVersion: h.emitEventStoredVersion,
}));
vi.mock("@/services/events/event-publish.service", () => ({
  previewEventPublish: h.previewEventPublish, publishEvent: h.publishEvent, listEventVersions: h.listEventVersions,
}));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));
vi.mock("@/services/events/asyncapi-import.service", () => ({ previewAsyncApiImport: h.previewAsyncApiImport, importAsyncApi: h.importAsyncApi }));
// The external-reference loaders and the event ownership read are their own tested units (event-external-ref-actions.test.ts and the
// integration tests): here they are spies, so what is proven is the PARENT check in front of them (the real `withOwnedTarget`).
vi.mock("@/services/events/external-refs.service", () => ({
  listExternalEventCandidates: h.listExternalEventCandidates, listExternalEventVersions: h.listExternalEventVersions,
  getExternalVersionItems: h.getExternalVersionItems, getExternalRefStatuses: h.getExternalRefStatuses,
}));
// The pin schema renderer (message examples) is its own tested unit (pin-json-schema.service.test.ts): a spy behind the parent check.
vi.mock("@/services/events/pin-json-schema.service", () => ({ renderPinJsonSchema: h.renderPinJsonSchema }));
vi.mock("@/services/events/service-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events/service-guards")>()),
  requireOwnedEvent: h.requireOwnedEvent,
}));

import {
  createEventAction, deleteEventAction, emitEventDraftAction, getExternalRefStatusesAction, getExternalVersionItemsAction, importAsyncApiAction,
  listEventVersionsAction, listExternalEventCandidatesAction, listExternalEventVersionsAction, pinJsonSchemaAction, previewAsyncApiImportAction,
  previewEventDocumentAction, previewEventPublishAction, publishEventAction, readEventVersionAction, renameEventAction, updateEventDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { createTraitAction, deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const T = "tenant-1";
const OTHER = "tenant-2";
type Mock = ReturnType<typeof vi.fn>;
const asAny = (v: unknown) => v as never;
const PRISMA_TEXT = "Invalid `prisma.product.findUnique()` invocation in\n/Users/dev/src/my/super-schema/src/lib/asset-scope.ts:30:18\n→ 30 db.product.findUnique({ where: { id: undefined";
const LEAKS = /prisma|Users\/dev|asset-scope|invocation|undefined/i;
const OK = { success: true, data: { id: "x" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue(T);
  resetSessionPrincipal();
  // the entity a message pins: in the active tenant, readable (a platform administrator reads it)
  h.findEntity.mockImplementation(async () => ({ tenantId: await h.getActiveTenantId(), domainId: "d-own", productId: "p-own", product: { domainId: "d-own" } }));
  // p-own is in a domain of the active tenant, p-foreign in another tenant's, anything else does not exist
  h.findProduct.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "p-own" ? { id: "p-own", domainId: "d-own", domain: { tenantId: T } }
      : where.id === "p-foreign" ? { id: "p-foreign", domainId: "d-foreign", domain: { tenantId: OTHER } } : null
  );
  h.findDomain.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "d-own" ? { id: "d-own", tenantId: T } : where.id === "d-foreign" ? { id: "d-foreign", tenantId: OTHER } : null
  );
  h.findTenant.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id }));
  for (const key of [
    "createEvent", "updateEventDocument", "renameEvent", "deleteEvent", "emitEventDocumentPreview", "emitEventDraft",
    "previewEventPublish", "publishEvent", "listEventVersions", "emitEventStoredVersion",
    "listExternalEventCandidates", "listExternalEventVersions", "getExternalVersionItems", "getExternalRefStatuses", "renderPinJsonSchema",
    "createTrait", "updateTrait", "deleteTrait", "previewAsyncApiImport", "importAsyncApi",
  ] as const) h[key].mockResolvedValue(OK);
  h.requireOwnedEvent.mockResolvedValue({ success: true, data: "e1" });
});

// ---------------------------------------------------------------------------
// The product-addressed Event actions
// ---------------------------------------------------------------------------

const PRODUCT_CASES: Array<{ label: string; call: (productId: string) => Promise<unknown>; service: Mock; mutates: boolean }> = [
  { label: "createEventAction", call: (p) => createEventAction(p, { name: "e" }), service: h.createEvent, mutates: true },
  { label: "updateEventDocumentAction", call: (p) => updateEventDocumentAction("e1", p, {}), service: h.updateEventDocument, mutates: true },
  { label: "renameEventAction", call: (p) => renameEventAction("e1", p, "new"), service: h.renameEvent, mutates: true },
  { label: "deleteEventAction", call: (p) => deleteEventAction("e1", p), service: h.deleteEvent, mutates: true },
  { label: "previewEventDocumentAction", call: (p) => previewEventDocumentAction("e1", p, {}), service: h.emitEventDocumentPreview, mutates: false },
  { label: "emitEventDraftAction", call: (p) => emitEventDraftAction("e1", p), service: h.emitEventDraft, mutates: false },
  { label: "previewEventPublishAction", call: (p) => previewEventPublishAction("e1", p), service: h.previewEventPublish, mutates: false },
  { label: "publishEventAction", call: (p) => publishEventAction("e1", p, { bump: "MINOR" }), service: h.publishEvent, mutates: true },
  { label: "listEventVersionsAction", call: (p) => listEventVersionsAction("e1", p), service: h.listEventVersions, mutates: false },
  { label: "readEventVersionAction", call: (p) => readEventVersionAction("e1", p, "1.0"), service: h.emitEventStoredVersion, mutates: false },
  // The external-reference read actions (the reference picker and the "newer version" badge): read-only, tenant-scoped loaders.
  { label: "listExternalEventCandidatesAction", call: (p) => listExternalEventCandidatesAction(p, "e1", "ord"), service: h.listExternalEventCandidates, mutates: false },
  { label: "listExternalEventVersionsAction", call: (p) => listExternalEventVersionsAction(p, "src1"), service: h.listExternalEventVersions, mutates: false },
  { label: "getExternalVersionItemsAction", call: (p) => getExternalVersionItemsAction(p, "v1"), service: h.getExternalVersionItems, mutates: false },
  { label: "getExternalRefStatusesAction", call: (p) => getExternalRefStatusesAction(p, []), service: h.getExternalRefStatuses, mutates: false },
  // The schema of a message's payload / headers pin (the example editor's validation and "Generate from payload"): a read-only render.
  { label: "pinJsonSchemaAction", call: (p) => pinJsonSchemaAction(p, { entityId: "ent-1", entityVersionId: null }), service: h.renderPinJsonSchema, mutates: false },
  // The AsyncAPI importer (productId FIRST): the preview is read-only, the import creates entities and an event in the client-supplied product.
  { label: "previewAsyncApiImportAction", call: (p) => previewAsyncApiImportAction(p, { content: "asyncapi: 3.0.0\n" }), service: h.previewAsyncApiImport, mutates: false },
  { label: "importAsyncApiAction", call: (p) => importAsyncApiAction(p, { content: "asyncapi: 3.0.0\n" }), service: h.importAsyncApi, mutates: true },
];

const NOT_FOUND = (id: string) => ({ success: false, error: `Product "${id}" not found`, code: "NOT_FOUND" });

describe.each(PRODUCT_CASES)("$label", ({ call, service, mutates }) => {
  it("works for a product of the active tenant (the service runs with the product owner target, unchanged)", async () => {
    expect(await call("p-own")).toMatchObject({ success: true });
    expect(service).toHaveBeenCalledTimes(1);
    if (mutates) expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
    else expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a product of ANOTHER tenant with the NOT_FOUND of an unknown product, and the service never runs", async () => {
    expect(await call("p-foreign")).toEqual(NOT_FOUND("p-foreign"));
    expect(service).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a MISSING product with the very same shape (no existence oracle across tenants)", async () => {
    const foreign = await call("p-foreign");
    h.findProduct.mockResolvedValue(null);
    const missing = await call("p-foreign");
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(service).not.toHaveBeenCalled();
  });

  it("follows the ACTIVE tenant: foreign today, the caller's after a tenant switch", async () => {
    expect(await call("p-foreign")).toMatchObject({ code: "NOT_FOUND" });
    h.getActiveTenantId.mockResolvedValue(OTHER);
    expect(await call("p-foreign")).toMatchObject({ success: true });
  });

  it("requires a session before any query", async () => {
    h.auth.mockResolvedValue(null);
    expect(await call("p-own")).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  it("returns the generic message (logged) when the ownership lookup throws a Prisma error with a path", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.findProduct.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = (await call("p-own")) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe(GENERIC_ACTION_ERROR);
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    expect(service).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("answers a malformed product id as a missing product (no query, no write reachable: fail closed)", async () => {
    service.mockResolvedValue({ success: true, data: { id: "x" } });
    for (const bad of [5, null, undefined, "", {}]) {
      expect(await call(asAny(bad)), JSON.stringify(bad)).toEqual({ success: false, error: 'Product "" not found', code: "NOT_FOUND" });
    }
    expect(h.findProduct).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The 3 library trait actions (owner target: TENANT / DOMAIN; a PRODUCT target is still checked the same way)
// ---------------------------------------------------------------------------

type Target = { level: "TENANT"; tenantId: string } | { level: "DOMAIN"; domainId: string } | { level: "PRODUCT"; productId: string };
const TRAIT_CASES: Array<{ label: string; call: (target: Target) => Promise<unknown>; service: Mock }> = [
  { label: "createTraitAction", call: (t) => createTraitAction(t, { name: "CloudEvents", kind: "MESSAGE" }), service: h.createTrait },
  { label: "updateTraitAction", call: (t) => updateTraitAction("t1", t, { name: "CloudEvents" }), service: h.updateTrait },
  { label: "deleteTraitAction", call: (t) => deleteTraitAction("t1", t), service: h.deleteTrait },
];

describe.each(TRAIT_CASES)("$label", ({ call, service }) => {
  it("works at Enterprise level (the TENANT target is always the active tenant), domain level and product level of the active tenant", async () => {
    for (const target of [
      { level: "TENANT", tenantId: "client-supplied-ignored" }, { level: "DOMAIN", domainId: "d-own" }, { level: "PRODUCT", productId: "p-own" },
    ] as Target[]) {
      expect(await call(target), JSON.stringify(target)).toMatchObject({ success: true });
    }
    expect(service).toHaveBeenCalledTimes(3);
    expect(service.mock.calls[0].find((a) => typeof a === "object" && a !== null && "level" in a)).toEqual({ level: "TENANT", tenantId: T });
  });

  it("answers a DOMAIN or PRODUCT owner of ANOTHER tenant with the NOT_FOUND of an unknown one, and the service never runs", async () => {
    expect(await call({ level: "DOMAIN", domainId: "d-foreign" })).toEqual({ success: false, error: 'Domain "d-foreign" not found', code: "NOT_FOUND" });
    expect(await call({ level: "PRODUCT", productId: "p-foreign" })).toEqual(NOT_FOUND("p-foreign"));
    expect(service).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("answers a missing owner byte-identically", async () => {
    const foreign = await call({ level: "DOMAIN", domainId: "d-foreign" });
    h.findDomain.mockResolvedValue(null);
    const missing = await call({ level: "DOMAIN", domainId: "d-foreign" });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(missing));
    expect(service).not.toHaveBeenCalled();
  });

  it("a TENANT target naming another tenant never reaches the service as that tenant (it is replaced by the active one)", async () => {
    await call({ level: "TENANT", tenantId: OTHER });
    const target = service.mock.calls[0].find((a) => typeof a === "object" && a !== null && "level" in a);
    expect(target).toEqual({ level: "TENANT", tenantId: T });
  });

  it("answers a malformed owner target as a missing one: no query, the service never runs (fail closed)", async () => {
    expect(await call(asAny(null))).toEqual({ success: false, error: "Target not found", code: "NOT_FOUND" });
    expect(service).not.toHaveBeenCalled();
    expect(h.findDomain).not.toHaveBeenCalled();
    expect(h.findProduct).not.toHaveBeenCalled();
  });

  it("returns the generic message when the ownership lookup throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.findDomain.mockRejectedValue(new Error(PRISMA_TEXT));
    const result = (await call({ level: "DOMAIN", domainId: "d-own" })) as { error: string };
    expect(result.error).toBe(GENERIC_ACTION_ERROR);
    expect(JSON.stringify(result)).not.toMatch(LEAKS);
    expect(service).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
