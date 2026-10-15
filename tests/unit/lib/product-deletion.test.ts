import { describe, expect, it } from "vitest";
import {
  combineBlockers,
  eventsAssetParts,
  eventsAssetTotal,
  productDeleteBlocker,
} from "@/lib/product-deletion";

const EMPTY = {
  entities: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
  channels: 0,
  messages: 0,
  traits: 0,
  eventSpecs: 0,
};

describe("productDeleteBlocker", () => {
  it("allows deleting an empty product", () => {
    expect(productDeleteBlocker(EMPTY)).toBeNull();
  });

  it("keeps the entity rule", () => {
    expect(productDeleteBlocker({ ...EMPTY, entities: 2 })).toBe(
      "Delete the product's 2 entities before removing it"
    );
  });

  it("blocks when product-level Data Types exist (enums + scalars + unions)", () => {
    expect(
      productDeleteBlocker({ ...EMPTY, sharedEnums: 1, customScalars: 1, unionTypes: 1 })
    ).toBe("Delete the product's 3 Data Types before removing it");
  });

  it("blocks when product-level APIs exist", () => {
    expect(productDeleteBlocker({ ...EMPTY, services: 1 })).toBe(
      "Delete the product's 1 API before removing it"
    );
  });

  it("lists every kind that would be cascade-deleted", () => {
    expect(
      productDeleteBlocker({ ...EMPTY, entities: 1, sharedEnums: 1, services: 2 })
    ).toBe("Delete the product's 1 entity, 1 Data Type and 2 APIs before removing it");
  });

  describe("Events assets", () => {
    it.each([
      [{ channels: 1 }, "Delete the product's 1 channel before removing it"],
      [{ channels: 3 }, "Delete the product's 3 channels before removing it"],
      [{ messages: 1 }, "Delete the product's 1 message before removing it"],
      [{ messages: 2 }, "Delete the product's 2 messages before removing it"],
      [{ traits: 1 }, "Delete the product's 1 trait before removing it"],
      [{ traits: 4 }, "Delete the product's 4 traits before removing it"],
      [{ eventSpecs: 1 }, "Delete the product's 1 event spec before removing it"],
      [{ eventSpecs: 2 }, "Delete the product's 2 event specs before removing it"],
    ])("blocks on %j alone", (counts, message) => {
      expect(productDeleteBlocker({ ...EMPTY, ...counts })).toBe(message);
    });

    it("lists every Events kind next to the existing kinds, in a fixed order", () => {
      expect(
        productDeleteBlocker({
          entities: 1,
          sharedEnums: 0,
          customScalars: 0,
          unionTypes: 0,
          services: 2,
          channels: 2,
          messages: 3,
          traits: 1,
          eventSpecs: 1,
        })
      ).toBe(
        "Delete the product's 1 entity, 2 APIs, 2 channels, 3 messages, 1 trait and 1 event spec before removing it"
      );
    });
  });
});

describe("eventsAssetParts / eventsAssetTotal", () => {
  it("omits zero kinds and totals the rest", () => {
    const counts = { channels: 0, messages: 2, traits: 0, eventSpecs: 1 };
    expect(eventsAssetParts(counts)).toEqual(["2 messages", "1 event spec"]);
    expect(eventsAssetTotal(counts)).toBe(3);
    expect(eventsAssetParts({ channels: 0, messages: 0, traits: 0, eventSpecs: 0 })).toEqual([]);
  });
});

describe("combineBlockers", () => {
  it("returns null when nothing blocks and a lone blocker untouched", () => {
    expect(combineBlockers([])).toBeNull();
    expect(combineBlockers([null, undefined, ""])).toBeNull();
    expect(combineBlockers(["Delete the product's 1 entity before removing it"])).toBe(
      "Delete the product's 1 entity before removing it"
    );
  });

  it("separates several blockers into sentences without doubling periods", () => {
    expect(combineBlockers(["First", null, "Second."])).toBe("First. Second.");
    expect(combineBlockers(["First.", "Second"])).toBe("First. Second");
  });
});
