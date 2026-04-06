import { describe, it, expect } from "vitest";
import {
  fontScaleValues,
  FONT_SCALE_STORAGE_KEY,
  type FontScale,
} from "@/lib/font-size";

describe("Font Size utilities", () => {
  it("defines 3 scales: small, medium, large", () => {
    const keys = Object.keys(fontScaleValues);
    expect(keys).toHaveLength(3);
    expect(keys).toContain("small");
    expect(keys).toContain("medium");
    expect(keys).toContain("large");
  });

  it("small scale is 0.875", () => {
    expect(fontScaleValues.small).toBe(0.875);
  });

  it("medium scale is 1.0", () => {
    expect(fontScaleValues.medium).toBe(1.0);
  });

  it("large scale is 1.125", () => {
    expect(fontScaleValues.large).toBe(1.125);
  });

  it("uses correct localStorage key", () => {
    expect(FONT_SCALE_STORAGE_KEY).toBe("super-schema:font-scale");
  });

  it("produces valid CSS multiplier strings", () => {
    for (const [, value] of Object.entries(fontScaleValues)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(2);
    }
  });
});
