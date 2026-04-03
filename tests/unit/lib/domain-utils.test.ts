import { describe, it, expect } from "vitest";
import { toSlug, fromSlug } from "@/lib/domain-utils";

describe("domain-utils", () => {
  describe("toSlug", () => {
    it("converts name to lowercase with hyphens", () => {
      expect(toSlug("Customer Domain")).toBe("customer-domain");
    });

    it("strips non-alphanumeric characters", () => {
      expect(toSlug("Payment & Billing")).toBe("payment-billing");
    });

    it("handles single word", () => {
      expect(toSlug("Public")).toBe("public");
    });

    it("trims whitespace", () => {
      expect(toSlug("  Playground  ")).toBe("playground");
    });

    it("collapses multiple hyphens", () => {
      expect(toSlug("A   B   C")).toBe("a-b-c");
    });
  });

  describe("fromSlug", () => {
    it("converts hyphens back to spaces", () => {
      expect(fromSlug("customer-domain")).toBe("customer domain");
    });

    it("handles single word", () => {
      expect(fromSlug("public")).toBe("public");
    });
  });
});
