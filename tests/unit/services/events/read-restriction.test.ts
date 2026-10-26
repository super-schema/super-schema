// @vitest-environment node
/**
 * The two tenant-wide Events loaders that take the caller's read scope from the action (access-control Task 5b): the external-reference
 * loaders restrict their QUERY to the events under the listed domains and products (so a page is never cut before the filter), and the usage
 * lookup drops the referrers the caller may not read (like another tenant's: never shown, never a "(deleted)" ghost).
 */
import { describe, expect, it, vi } from "vitest";
import { getExternalRefStatuses, getExternalVersionItems, listExternalEventCandidates, listExternalEventVersions } from "@/services/events/external-refs.service";
import { findUsages } from "@/services/events/usage.service";

const T = "tenant-1";
const RESTRICT = { domainIds: ["dom-a"], productIds: ["prod-x"] };
const WITHIN = { OR: [{ domainId: { in: ["dom-a"] } }, { productId: { in: ["prod-x"] } }] };

function ctxOf(prisma: Record<string, unknown>) {
  return { userId: "u1", userRole: "VIEWER", assignments: [], prisma } as never;
}

describe("external-reference loaders: the read scope is part of the query", () => {
  it("candidates: restricted in the where clause, unrestricted otherwise", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = ctxOf({ eventSpec: { findMany } });
    await listExternalEventCandidates(ctx, { tenantId: T, excludeEventId: "e1", restrictTo: RESTRICT });
    expect(findMany.mock.calls[0][0].where.AND).toEqual([WITHIN]);
    await listExternalEventCandidates(ctx, { tenantId: T, excludeEventId: "e1" });
    expect(findMany.mock.calls[1][0].where.AND).toEqual([{}]);
  });

  it("candidates: a restriction with no domain and no product matches nothing (an empty list, not everything)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listExternalEventCandidates(ctxOf({ eventSpec: { findMany } }), { tenantId: T, excludeEventId: "e1", restrictTo: { domainIds: [], productIds: [] } });
    expect(findMany.mock.calls[0][0].where.AND).toEqual([{ OR: [{ domainId: { in: [] } }, { productId: { in: [] } }] }]);
  });

  it("versions of one event, items of one version and the status of references: an event outside the scope is the same NOT_FOUND as a missing one", async () => {
    const eventFind = vi.fn().mockResolvedValue(null);
    const versionFind = vi.fn().mockResolvedValue(null);
    const versionMany = vi.fn().mockResolvedValue([]);
    const ctx = ctxOf({ eventSpec: { findFirst: eventFind }, eventSpecVersion: { findFirst: versionFind, findMany: versionMany } });

    const versions = await listExternalEventVersions(ctx, { tenantId: T, eventId: "src1", restrictTo: RESTRICT });
    expect(versions).toEqual({ success: false, error: { code: "NOT_FOUND", message: 'Event "src1" not found' } });
    expect(eventFind.mock.calls[0][0].where).toEqual({ id: "src1", tenantId: T, AND: [WITHIN] });

    const items = await getExternalVersionItems(ctx, { tenantId: T, eventVersionId: "v1", restrictTo: RESTRICT });
    expect(items).toEqual({ success: false, error: { code: "NOT_FOUND", message: 'Event version "v1" not found' } });
    expect(versionFind.mock.calls[0][0].where).toEqual({ id: "v1", eventSpec: { tenantId: T, AND: [WITHIN] } });

    const statuses = await getExternalRefStatuses(ctx, { tenantId: T, refs: [{ eventVersionId: "v1", kind: "channel", itemKey: "orders" }], restrictTo: RESTRICT });
    expect(statuses).toEqual({ success: false, error: { code: "NOT_FOUND", message: 'Event version "v1" not found' } });
    expect(versionMany.mock.calls[0][0].where).toEqual({ id: { in: ["v1"] }, eventSpec: { tenantId: T, AND: [WITHIN] } });
  });
});

describe("usage lookup: referrers the caller may not read are dropped", () => {
  const place = (domainId: string | null, productId: string | null) => ({ tenantId: T, domainId, productId, domain: { slug: "d" }, product: { slug: "p" } });
  const REFS = [
    { id: "r1", fromKind: "EVENT_SPEC", fromId: "ev-a", role: "PAYLOAD", isDraft: false, toId: "ver1" },
    { id: "r2", fromKind: "EVENT_SPEC", fromId: "ev-b", role: "PAYLOAD", isDraft: false, toId: "ver1" },
    { id: "r3", fromKind: "TRAIT", fromId: "tr-b", role: "HEADERS", isDraft: false, toId: "ver1" },
  ];
  const prisma = () => ({
    entity: { findFirst: vi.fn().mockResolvedValue({ name: "Order", versions: [{ id: "ver1", major: 1, minor: 0 }] }) },
    schemaReference: { findMany: vi.fn().mockResolvedValue(REFS) },
    entityVersion: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpecVersion: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpec: {
      findMany: vi.fn().mockResolvedValue([
        { id: "ev-a", name: "A", ...place("dom-a", "prod-a") },
        { id: "ev-b", name: "B", ...place("dom-b", "prod-b") },
      ]),
    },
    trait: { findMany: vi.fn().mockResolvedValue([{ id: "tr-b", name: "T", ...place("dom-b", null) }]) },
  });

  it("lists every referrer of the tenant when no filter is given", async () => {
    const result = await findUsages({ kind: "entity", entityId: "ent-1" }, ctxOf(prisma()), T);
    expect(result.success && result.data.map((row) => row.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps only the referrers the filter allows, never a ghost for a hidden one", async () => {
    const seen: string[] = [];
    const result = await findUsages({ kind: "entity", entityId: "ent-1" }, ctxOf(prisma()), T, (kind, where) => {
      seen.push(`${kind}:${where.domainId}`);
      return where.domainId === "dom-a";
    });
    expect(result.success && result.data.map((row) => row.id)).toEqual(["r1"]);
    expect(seen.sort()).toEqual(["event:dom-a", "event:dom-b", "trait:dom-b"]);
  });
});
