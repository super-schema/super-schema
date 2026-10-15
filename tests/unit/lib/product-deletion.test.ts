import { describe, expect, it } from "vitest";
import { productDeleteBlocker } from "@/lib/product-deletion";

const EMPTY = {
  entities: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
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
      productDeleteBlocker({ entities: 1, sharedEnums: 1, customScalars: 0, unionTypes: 0, services: 2 })
    ).toBe("Delete the product's 1 entity, 1 Data Type and 2 APIs before removing it");
  });
});
