import { describe, expect, it } from "vitest";
import { pluralize } from "@/lib/pluralize";

describe("pluralize", () => {
  it("uses the singular for exactly one, the plural for zero and many", () => {
    expect(pluralize(0, "field")).toBe("0 fields");
    expect(pluralize(1, "field")).toBe("1 field");
    expect(pluralize(2, "field")).toBe("2 fields");
    expect(pluralize(120, "field")).toBe("120 fields");
  });

  it("takes an irregular plural", () => {
    expect(pluralize(1, "entity", "entities")).toBe("1 entity");
    expect(pluralize(0, "entity", "entities")).toBe("0 entities");
    expect(pluralize(3, "entity", "entities")).toBe("3 entities");
  });

  it("is plural for a negative or a fractional count (only exactly 1 is singular)", () => {
    expect(pluralize(-1, "field")).toBe("-1 fields");
    expect(pluralize(1.5, "field")).toBe("1.5 fields");
  });
});
