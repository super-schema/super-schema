import { describe, it, expect } from "vitest";
import { assetInUseError, findTraitReferrers } from "@/services/events/delete-guards";

// What is left of the legacy trait guard: the catalog messages / version-1 event specs it used to name no longer exist, so it
// reads nothing and never blocks (the event guard, findLibraryTraitEventReferrers, is the guard). trait.service.ts still calls it.
describe("findTraitReferrers (compatibility shim)", () => {
  it("reads nothing and lists no referrer", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("the shim must not touch the database"); } });
    expect(await findTraitReferrers(db as never, { id: "t1", tenantId: "tn" })).toEqual({ referrers: [], truncated: false });
  });
});

describe("assetInUseError (compatibility shim)", () => {
  it("is null for the empty list findTraitReferrers returns", () => {
    expect(assetInUseError("Trait", "CloudEvents", { referrers: [], truncated: false })).toBeNull();
  });

  it("still reports IN_USE with the structured list when handed referrers", () => {
    const found = { referrers: [{ kind: "Event spec" as const, id: "s1", name: "checkout", versions: ["1.0"], draft: false }], truncated: false };
    expect(assetInUseError("Trait", "CloudEvents", found)).toEqual({
      code: "IN_USE",
      message: 'Trait "CloudEvents" cannot be deleted: it is still in use.',
      details: { referrers: found.referrers, truncated: false },
    });
  });
});
