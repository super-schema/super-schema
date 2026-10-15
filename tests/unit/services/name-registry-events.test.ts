import { describe, it, expect } from "vitest";
import { assertNameAvailable } from "@/services/name-registry.service";
import { emptyRegistryDelegates } from "../../helpers/registry-mocks";

const fakeDb = (rows: Parameters<typeof emptyRegistryDelegates>[0]) => emptyRegistryDelegates(rows);

describe("name registry — events kinds", () => {
  it("treats channels, messages, traits and event specs as line-unique names", async () => {
    const db = fakeDb({ channel: [{ id: "c1", name: "orders", tenantId: "t", domainId: "d1", productId: "p1" }] });
    const r = await assertNameAvailable(db as never, { name: "Orders", tenantId: "t", domainId: "d1", productId: "p1" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.message).toBe('"Orders" is already used by Channel "orders" at Product level.');
  });

  it("sees tenant-level traits from every product line and ignores sibling products", async () => {
    const db = fakeDb({
      trait: [{ id: "t1", name: "CloudEvents", tenantId: "t", domainId: null, productId: null }],
      eventSpec: [{ id: "s1", name: "checkout-service", tenantId: "t", domainId: "d1", productId: "p1" }],
    });
    const traitClash = await assertNameAvailable(db as never, { name: "cloudevents", tenantId: "t", domainId: "d2", productId: "p9" });
    expect(!traitClash.success && traitClash.error.message).toMatch(/Trait "CloudEvents" at Enterprise level/);
    const sibling = await assertNameAvailable(db as never, { name: "checkout-service", tenantId: "t", domainId: "d1", productId: "p2" });
    expect(sibling.success).toBe(true);
  });

  it("excludes the record being renamed", async () => {
    const db = fakeDb({ message: [{ id: "m1", name: "OrderCreated", tenantId: "t", domainId: "d1", productId: "p1" }] });
    const r = await assertNameAvailable(db as never, {
      name: "OrderCreated", tenantId: "t", domainId: "d1", productId: "p1", exclude: { kind: "message", id: "m1" },
    });
    expect(r.success).toBe(true);
  });
});
