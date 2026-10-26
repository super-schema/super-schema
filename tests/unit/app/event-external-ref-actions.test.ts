import { assign, resetSessionPrincipal } from "../../helpers/access-mocks";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(), revalidatePath: vi.fn(), findProduct: vi.fn(), getActiveTenantId: vi.fn(),
  requireOwnedEvent: vi.fn(), listCandidates: vi.fn(), listVersions: vi.fn(), getItems: vi.fn(), getStatuses: vi.fn(),
}));
// The real guard runs (the principal is a platform administrator unless a test says otherwise): the client-supplied product must lie in the
// active tenant. The role rules of these actions are in events-area-access.test.ts, the foreign-tenant ones in events-actions-tenant-guard.test.ts.
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma", product: { findUnique: h.findProduct } } }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).sessionPrincipalModule);
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/services/events/external-refs.service", () => ({
  listExternalEventCandidates: h.listCandidates, listExternalEventVersions: h.listVersions,
  getExternalVersionItems: h.getItems, getExternalRefStatuses: h.getStatuses,
}));
vi.mock("@/services/events/service-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/events/service-guards")>()),
  requireOwnedEvent: h.requireOwnedEvent,
}));

import {
  getExternalRefStatusesAction, getExternalVersionItemsAction, listExternalEventCandidatesAction, listExternalEventVersionsAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

const CTX = { userId: "u1", userRole: "ADMIN", assignments: [assign.global()], prisma: { tag: "prisma", product: { findUnique: h.findProduct } } };
const OWNER = { level: "PRODUCT", productId: "p1" };
const TENANT = "tenant-active";
const REFS = [{ eventVersionId: "v1", kind: "channel" as const, itemKey: "orders" }];
const SERVICES = [h.listCandidates, h.listVersions, h.getItems, h.getStatuses];

const ALL_ACTIONS: Array<[string, () => Promise<unknown>]> = [
  ["listExternalEventCandidatesAction", () => listExternalEventCandidatesAction("p1", "e1", "ord")],
  ["listExternalEventVersionsAction", () => listExternalEventVersionsAction("p1", "src1")],
  ["getExternalVersionItemsAction", () => getExternalVersionItemsAction("p1", "v1")],
  ["getExternalRefStatusesAction", () => getExternalRefStatusesAction("p1", REFS)],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  resetSessionPrincipal();
  h.findProduct.mockResolvedValue({ domainId: "d1", domain: { tenantId: TENANT } });
  h.getActiveTenantId.mockResolvedValue(TENANT);
  h.requireOwnedEvent.mockResolvedValue({ success: true, data: "e1-owned" });
  for (const fn of SERVICES) fn.mockResolvedValue({ success: true, data: [] });
});

describe("external reference read actions", () => {
  it("take the tenant from the active tenant and hand the loaders only what the client may choose", async () => {
    await listExternalEventCandidatesAction("p1", "e1", "ord");
    await listExternalEventVersionsAction("p1", "src1");
    await getExternalVersionItemsAction("p1", "v1");
    await getExternalRefStatusesAction("p1", REFS);
    expect(h.listCandidates).toHaveBeenCalledWith(CTX, { tenantId: TENANT, excludeEventId: "e1-owned", query: "ord" });
    expect(h.listVersions).toHaveBeenCalledWith(CTX, { tenantId: TENANT, eventId: "src1" });
    expect(h.getItems).toHaveBeenCalledWith(CTX, { tenantId: TENANT, eventVersionId: "v1" });
    expect(h.getStatuses).toHaveBeenCalledWith(CTX, { tenantId: TENANT, refs: REFS });
  });

  it("leave out the event the ownership check returned, not the id the client sent", async () => {
    h.requireOwnedEvent.mockResolvedValue({ success: true, data: "the-owned-one" });
    await listExternalEventCandidatesAction("p1", "client-says-this", undefined);
    expect(h.requireOwnedEvent).toHaveBeenCalledWith(CTX, "client-says-this", OWNER);
    expect(h.listCandidates.mock.calls[0][1]).toMatchObject({ excludeEventId: "the-owned-one" });
  });

  it("never list candidates for an event the product does not own, and pass the refusal on untouched", async () => {
    h.requireOwnedEvent.mockResolvedValue({ success: false, error: { code: "FORBIDDEN", message: 'Event "e9" is owned by another Product scope and is read-only here.' } });
    expect(await listExternalEventCandidatesAction("p1", "e9", "x")).toEqual({
      success: false, error: 'Event "e9" is owned by another Product scope and is read-only here.', code: "FORBIDDEN",
    });
    expect(h.listCandidates).not.toHaveBeenCalled();
  });

  it("check the client-supplied product against the active tenant before any service call", async () => {
    for (const [, call] of ALL_ACTIONS) {
      h.findProduct.mockClear();
      await call();
      expect(h.findProduct).toHaveBeenCalledTimes(1);
      expect(h.findProduct.mock.calls[0][0]).toMatchObject({ where: { id: "p1" } });
    }
  });

  it("never reach a loader when the product is not in the active tenant", async () => {
    h.findProduct.mockResolvedValue(null);
    for (const [, call] of ALL_ACTIONS) expect(await call()).toEqual({ success: false, error: 'Product "p1" not found', code: "NOT_FOUND" });
    for (const fn of [...SERVICES, h.requireOwnedEvent]) expect(fn).not.toHaveBeenCalled();
  });

  it("answer UNAUTHORIZED without any lookup when there is no session", async () => {
    h.auth.mockResolvedValue(null);
    for (const [, call] of ALL_ACTIONS) expect(await call()).toMatchObject({ success: false, code: "UNAUTHORIZED" });
    for (const fn of [...SERVICES, h.requireOwnedEvent, h.findProduct, h.getActiveTenantId]) expect(fn).not.toHaveBeenCalled();
  });

  it("are read-only: a success never revalidates", async () => {
    for (const [, call] of ALL_ACTIONS) await call();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("return the data and a NOT_FOUND of a loader as they are", async () => {
    const items = { eventName: "orders", label: "1.0", channels: [], messages: [] };
    h.getItems.mockResolvedValueOnce({ success: true, data: items });
    expect(await getExternalVersionItemsAction("p1", "v1")).toEqual({ success: true, data: items });
    h.getStatuses.mockResolvedValueOnce({ success: false, error: { code: "NOT_FOUND", message: 'Event version "v7" not found' } });
    expect(await getExternalRefStatusesAction("p1", REFS)).toEqual({ success: false, error: 'Event version "v7" not found', code: "NOT_FOUND" });
  });

  it("keep raw database text and thrown errors out of the answer", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const RAW = 'relation "event_spec_versions" does not exist at 10.0.0.5:5432';
    for (const fn of SERVICES) fn.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: RAW } });
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    }
    for (const fn of SERVICES) fn.mockRejectedValue(new Error(RAW));
    for (const [, call] of ALL_ACTIONS) {
      expect(await call()).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    }
    h.getActiveTenantId.mockRejectedValue(new Error(RAW));
    for (const [, call] of ALL_ACTIONS) expect(JSON.stringify(await call())).not.toContain("10.0.0.5");
    consoleError.mockRestore();
  });
});
