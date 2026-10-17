import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  findUsages: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "VIEWER" }) }));
vi.mock("@/services/events/usage.service", () => ({ findUsages: h.findUsages }));

import { listUsagesAction } from "@/app/(dashboard)/schemas/usage-actions";
import { usageRowList } from "@/lib/events/usage";

const CTX = { userId: "user-1", userRole: "VIEWER", prisma: { tag: "prisma" } };
const SUBJECT = { kind: "entity", entityId: "e1" } as const;
const ROWS = [{ id: "r1", fromKind: "EVENT_SPEC" as const, role: "PAYLOAD", isDraft: true, target: "Order v1.0", label: "Event M (draft)", href: "/x" }];

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  h.resolveCurrentUserId.mockResolvedValue("user-1");
});

describe("listUsagesAction", () => {
  it("rejects unauthenticated calls without touching the service", async () => {
    h.auth.mockResolvedValue(null);
    expect(await listUsagesAction(SUBJECT)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(h.findUsages).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the server-resolved active tenant and never revalidates (read-only)", async () => {
    h.findUsages.mockResolvedValue({ success: true, data: usageRowList([...ROWS], false) });
    expect(await listUsagesAction(SUBJECT)).toEqual({ success: true, data: { rows: ROWS, truncated: false } });
    expect(h.findUsages).toHaveBeenCalledWith(SUBJECT, CTX, "tenant-active");
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  // `findUsages` returns an array carrying a NON-index `truncated` property; the server-action serializer drops such properties,
  // so the action must return `{ rows, truncated }` itself. A JSON round trip stands in for the wire.
  it("keeps `truncated` across the wire: the data is { rows, truncated }, not an array with a hidden property", async () => {
    h.findUsages.mockResolvedValue({ success: true, data: usageRowList([...ROWS], true) });
    const result = await listUsagesAction({ kind: "event", eventId: "ev1" });
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire).toEqual({ success: true, data: { rows: ROWS, truncated: true } });
    expect(Array.isArray(wire.data)).toBe(false);
    expect(h.findUsages).toHaveBeenCalledWith({ kind: "event", eventId: "ev1" }, CTX, "tenant-active");
  });

  it("reports a list that is not truncated as `truncated: false` (also for a plain array without the flag)", async () => {
    h.findUsages.mockResolvedValue({ success: true, data: usageRowList([], false) });
    expect(JSON.parse(JSON.stringify(await listUsagesAction(SUBJECT)))).toEqual({ success: true, data: { rows: [], truncated: false } });
    h.findUsages.mockResolvedValue({ success: true, data: ROWS });
    expect(JSON.parse(JSON.stringify(await listUsagesAction(SUBJECT)))).toEqual({ success: true, data: { rows: ROWS, truncated: false } });
  });

  it("maps a service failure through toActionResult", async () => {
    h.findUsages.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: 'Entity "e1" not found' } });
    expect(await listUsagesAction(SUBJECT)).toEqual({ success: false, error: 'Entity "e1" not found', code: "NOT_FOUND" });
  });

  it("replaces DB_ERROR driver text with a generic message", async () => {
    h.findUsages.mockResolvedValue({ success: false, error: { code: "DB_ERROR", message: 'password authentication failed for user "pg" at 10.0.0.5:5432' } });
    const r = await listUsagesAction(SUBJECT);
    expect(r).toEqual({ success: false, error: "Could not load usages. Try again.", code: "DB_ERROR" });
    expect(JSON.stringify(r)).not.toContain("10.0.0.5");
  });
});
