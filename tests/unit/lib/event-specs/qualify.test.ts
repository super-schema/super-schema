import { describe, it, expect } from "vitest";
import { qualifyNames } from "@/lib/event-specs/qualify";

describe("qualifyNames (spec §7.2 step 5)", () => {
  it("keeps unique names", () => {
    const { names, disambiguated } = qualifyNames(
      [
        { key: "a", name: "orders", owner: "checkout" },
        { key: "b", name: "refunds", owner: "payments" },
      ],
      "checkout",
    );
    expect(Object.fromEntries(names)).toEqual({ a: "orders", b: "refunds" });
    expect(disambiguated).toEqual([]);
  });

  it("qualifies the foreign item when a home item has the same name", () => {
    const { names } = qualifyNames(
      [
        { key: "fraud-orders", name: "orders", owner: "fraud" },
        { key: "checkout-orders", name: "orders", owner: "checkout" },
      ],
      "fraud",
    );
    expect(Object.fromEntries(names)).toEqual({ "fraud-orders": "orders", "checkout-orders": "checkout.orders" });
  });

  it("qualifies every clashing item when none is home", () => {
    const { names } = qualifyNames(
      [
        { key: "x", name: "orders", owner: "checkout" },
        { key: "y", name: "orders", owner: "fraud" },
      ],
      "risk",
    );
    expect(Object.fromEntries(names)).toEqual({ x: "checkout.orders", y: "fraud.orders" });
  });

  it("falls back to numeric suffixes for same-owner clashes, independent of input order", () => {
    const items = [
      { key: "msgv-2", name: "OrderCreated", owner: "checkout" },
      { key: "msgv-1", name: "OrderCreated", owner: "checkout" },
    ];
    const forward = qualifyNames(items, "checkout");
    const reverse = qualifyNames([...items].reverse(), "checkout");
    expect(Object.fromEntries(forward.names)).toEqual({ "msgv-1": "OrderCreated", "msgv-2": "OrderCreated_2" });
    expect(Object.fromEntries(reverse.names)).toEqual(Object.fromEntries(forward.names));
    expect(forward.disambiguated).toEqual(["msgv-2"]);
  });
});
