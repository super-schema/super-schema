import { beforeEach, describe, expect, it, vi } from "vitest";

// The 20 Events create / update / delete / publish / preview / list actions (channels, messages, event specs, traits) take a
// CLIENT-supplied product (or owner target) and their services only compare the row against that owner, so a foreign product
// id was self-consistent (`createChannelAction("pB", ...)` created in tenant B). Each now requires the PARENT to lie in the
// ACTIVE tenant (`withOwnedTarget`, the REAL one here) and answers a foreign parent with exactly the NOT_FOUND `resolveScope`
// gives an unknown one, without starting the service. The services stay untouched behind it.

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  getEffectiveRole: vi.fn(),
  findDomain: vi.fn(),
  findProduct: vi.fn(),
  findTenant: vi.fn(),
  createChannel: vi.fn(), updateChannel: vi.fn(), setChannelMessages: vi.fn(), deleteChannel: vi.fn(),
  createMessage: vi.fn(), updateMessage: vi.fn(), deleteMessage: vi.fn(),
  createEventSpec: vi.fn(), updateEventSpecDocument: vi.fn(), renameEventSpec: vi.fn(), deleteEventSpec: vi.fn(),
  previewEventSpecPublish: vi.fn(), publishEventSpec: vi.fn(), listEventSpecVersions: vi.fn(),
  previewMessagePublish: vi.fn(), publishMessage: vi.fn(), listMessageVersions: vi.fn(),
  createTrait: vi.fn(), updateTrait: vi.fn(), deleteTrait: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { tag: "prisma", domain: { findUnique: h.findDomain }, product: { findUnique: h.findProduct }, tenant: { findUnique: h.findTenant } },
}));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/services/events/channel.service", () => ({
  createChannel: h.createChannel, updateChannel: h.updateChannel, setChannelMessages: h.setChannelMessages, deleteChannel: h.deleteChannel,
}));
vi.mock("@/services/events/message.service", () => ({ createMessage: h.createMessage, updateMessage: h.updateMessage, deleteMessage: h.deleteMessage }));
vi.mock("@/services/events/event-spec.service", () => ({
  createEventSpec: h.createEventSpec, updateEventSpecDocument: h.updateEventSpecDocument, renameEventSpec: h.renameEventSpec, deleteEventSpec: h.deleteEventSpec,
}));
vi.mock("@/services/events/event-spec-publish.service", () => ({
  previewEventSpecPublish: h.previewEventSpecPublish, publishEventSpec: h.publishEventSpec, listEventSpecVersions: h.listEventSpecVersions,
}));
vi.mock("@/services/events/message-publish.service", () => ({
  previewMessagePublish: h.previewMessagePublish, publishMessage: h.publishMessage, listMessageVersions: h.listMessageVersions,
}));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));

import {
  createChannelAction, deleteChannelAction, setChannelMessagesAction, updateChannelAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { createMessageAction, deleteMessageAction, updateMessageAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-actions";
import {
  createEventSpecAction, deleteEventSpecAction, renameEventSpecAction, updateEventSpecDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-actions";
import {
  getEventSpecPublishPreviewAction, listEventSpecVersionsAction, publishEventSpecAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions";
import {
  getMessagePublishPreviewAction, listMessageVersionsAction, publishMessageAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/message-version-actions";
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
  h.resolveCurrentUserId.mockResolvedValue("user-1");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
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
    "createChannel", "updateChannel", "setChannelMessages", "deleteChannel", "createMessage", "updateMessage", "deleteMessage", "createEventSpec",
    "updateEventSpecDocument", "renameEventSpec", "deleteEventSpec", "previewEventSpecPublish", "publishEventSpec", "listEventSpecVersions",
    "previewMessagePublish", "publishMessage", "listMessageVersions", "createTrait", "updateTrait", "deleteTrait",
  ] as const) h[key].mockResolvedValue(OK);
});

// ---------------------------------------------------------------------------
// The 17 product-addressed actions
// ---------------------------------------------------------------------------

const CHANNEL = { name: "orders", address: "a", protocol: "kafka", format: "avro" };
const PRODUCT_CASES: Array<{ label: string; call: (productId: string) => Promise<unknown>; service: Mock; mutates: boolean }> = [
  { label: "createChannelAction", call: (p) => createChannelAction(p, asAny(CHANNEL)), service: h.createChannel, mutates: true },
  { label: "updateChannelAction", call: (p) => updateChannelAction("c1", p, asAny(CHANNEL)), service: h.updateChannel, mutates: true },
  { label: "setChannelMessagesAction", call: (p) => setChannelMessagesAction("c1", p, ["m1"]), service: h.setChannelMessages, mutates: true },
  { label: "deleteChannelAction", call: (p) => deleteChannelAction("c1", p), service: h.deleteChannel, mutates: true },
  { label: "createMessageAction", call: (p) => createMessageAction(p, asAny({ name: "m" })), service: h.createMessage, mutates: true },
  { label: "updateMessageAction", call: (p) => updateMessageAction("m1", p, asAny({ name: "m" })), service: h.updateMessage, mutates: true },
  { label: "deleteMessageAction", call: (p) => deleteMessageAction("m1", p), service: h.deleteMessage, mutates: true },
  { label: "createEventSpecAction", call: (p) => createEventSpecAction(p, asAny({ name: "s" })), service: h.createEventSpec, mutates: true },
  { label: "updateEventSpecDocumentAction", call: (p) => updateEventSpecDocumentAction("s1", p, {}), service: h.updateEventSpecDocument, mutates: true },
  { label: "renameEventSpecAction", call: (p) => renameEventSpecAction("s1", p, "new"), service: h.renameEventSpec, mutates: true },
  { label: "deleteEventSpecAction", call: (p) => deleteEventSpecAction("s1", p), service: h.deleteEventSpec, mutates: true },
  { label: "getEventSpecPublishPreviewAction", call: (p) => getEventSpecPublishPreviewAction("s1", p), service: h.previewEventSpecPublish, mutates: false },
  { label: "publishEventSpecAction", call: (p) => publishEventSpecAction("s1", p, {}), service: h.publishEventSpec, mutates: true },
  { label: "listEventSpecVersionsAction", call: (p) => listEventSpecVersionsAction("s1", p), service: h.listEventSpecVersions, mutates: false },
  { label: "getMessagePublishPreviewAction", call: (p) => getMessagePublishPreviewAction("m1", p), service: h.previewMessagePublish, mutates: false },
  { label: "publishMessageAction", call: (p) => publishMessageAction("m1", p, {}), service: h.publishMessage, mutates: true },
  { label: "listMessageVersionsAction", call: (p) => listMessageVersionsAction("m1", p), service: h.listMessageVersions, mutates: false },
];

const NOT_FOUND = (id: string) => ({ success: false, error: `Product "${id}" not found`, code: "NOT_FOUND" });

describe.each(PRODUCT_CASES)("$label", ({ call, service, mutates }) => {
  it("works for a product of the active tenant (the service runs with the product owner target, unchanged)", async () => {
    expect(await call("p-own")).toMatchObject({ success: true });
    expect(service).toHaveBeenCalledTimes(1);
    if (mutates) expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
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

  it("leaves a malformed product id to the service's own validation (no query from the guard, no write reachable)", async () => {
    service.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "productId must be a non-empty string" } });
    expect(await call(asAny(5))).toEqual({ success: false, error: "productId must be a non-empty string", code: "VALIDATION_ERROR" });
    expect(h.findProduct).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The 3 trait actions (owner target: TENANT / DOMAIN / PRODUCT)
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

  it("leaves a malformed owner target to the service's own VALIDATION_ERROR (the existing contract)", async () => {
    service.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "Scope target must be an object" } });
    expect(await call(asAny(null))).toEqual({ success: false, error: "Scope target must be an object", code: "VALIDATION_ERROR" });
    expect(service).toHaveBeenCalledTimes(1);
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
