import { beforeEach, describe, expect, it, vi } from "vitest";

/** The loader's version-label gate runs before ANY read: a malformed label never reaches the route lookup or the driver. */
const h = vi.hoisted(() => ({ resolveProductRoute: vi.fn(), touched: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: (_t, prop) => { h.touched(String(prop)); throw new Error(`database read: ${String(prop)}`); } }),
}));
vi.mock("@/features/events/route-scope", () => ({ resolveProductRoute: h.resolveProductRoute }));

import { loadEventSpecPage } from "@/features/events/event-specs/load-event-spec-page";

const at = { domainSlug: "payments", productSlug: "checkout", specId: "s1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveProductRoute.mockResolvedValue(null);
});

describe("loadEventSpecPage — version label gate", () => {
  it.each([
    "99999999999.0", "1.99999999999", `${"9".repeat(400)}.0`, `1.${"9".repeat(400)}`, "2147483648.0", "1.2147483648",
    "abc", "1", "1.0.0", "0.1", "-1.0", "1e3.0", "1.0\n", "v", "vv1.0",
  ])("rejects %# with a null before resolving the route or reading the database", async (version) => {
    expect(await loadEventSpecPage({ ...at, version })).toBeNull();
    expect(h.resolveProductRoute).not.toHaveBeenCalled();
    expect(h.touched).not.toHaveBeenCalled();
  });

  it("lets a well-formed label through to the route lookup (an empty one means the draft)", async () => {
    expect(await loadEventSpecPage({ ...at, version: "2147483647.2147483647" })).toBeNull();
    expect(await loadEventSpecPage({ ...at, version: "v1.0" })).toBeNull();
    expect(await loadEventSpecPage({ ...at, version: "" })).toBeNull();
    expect(h.resolveProductRoute).toHaveBeenCalledTimes(3);
    expect(h.touched).not.toHaveBeenCalled(); // the stubbed route resolves to nothing, so nothing was read
  });
});
