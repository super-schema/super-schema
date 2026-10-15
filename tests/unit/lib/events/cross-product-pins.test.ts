import { describe, expect, it } from "vitest";
import { crossProductPinBlocker, type CrossProductPin } from "@/lib/events/cross-product-pins";

function pin(overrides: Partial<CrossProductPin> = {}): CrossProductPin {
  return {
    specId: "s1",
    specName: "orders-feed",
    productId: "p2",
    productName: "Fraud",
    versions: ["1.0"],
    assets: [{ kind: "Message", name: "OrderCreated" }],
    ...overrides,
  };
}

describe("crossProductPinBlocker", () => {
  it("returns null when no other product's spec references the target", () => {
    expect(crossProductPinBlocker([])).toBeNull();
  });

  it("names the spec, its product, the published versions and the referenced asset", () => {
    expect(crossProductPinBlocker([pin()])).toBe(
      'A published event spec in another product references assets owned here: "orders-feed" (product "Fraud", v1.0) references Message "OrderCreated". Delete that event spec first (published versions cannot be changed), then retry.'
    );
  });

  it("lists every published version and every asset kind of one spec", () => {
    const message = crossProductPinBlocker([
      pin({
        versions: ["1.0", "1.1", "2.0"],
        assets: [
          { kind: "Message", name: "OrderCreated" },
          { kind: "Channel", name: "orders" },
        ],
      }),
    ]);
    expect(message).toContain('(product "Fraud", v1.0, v1.1, v2.0) references Message "OrderCreated" and Channel "orders"');
  });

  it("caps long asset lists", () => {
    const message = crossProductPinBlocker([
      pin({
        assets: ["A", "B", "C", "D", "E"].map((name) => ({ kind: "Trait" as const, name })),
      }),
    ]);
    expect(message).toContain('references Trait "A", Trait "B", Trait "C" and 2 more.');
  });

  it("names several specs (plural wording) and caps the list", () => {
    const pins = ["a", "b", "c", "d", "e", "f", "g"].map((name, i) =>
      pin({ specId: `s${i}`, specName: name, productId: `p${i}`, productName: `Prod ${name}` })
    );
    const message = crossProductPinBlocker(pins) ?? "";
    expect(message.startsWith("Published event specs in other products reference assets owned here:")).toBe(true);
    expect(message).toContain('"a" (product "Prod a", v1.0)');
    expect(message).toContain('"e" (product "Prod e", v1.0)');
    expect(message).not.toContain('"f" (product');
    expect(message).toContain("and 2 more.");
    expect(message).toContain("Delete those event specs first");
  });
});
