import { describe, it, expect } from "vitest";
import { assetHref } from "@/lib/navigation/asset-href";

describe("assetHref — events kinds", () => {
  it("links the product Events tab with a section (default specs)", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=events&section=specs");
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout", section: "channels" })).toBe(
      "/schemas/payments/checkout?tab=events&section=channels"
    );
  });

  it("links detail pages for every level and versions", () => {
    expect(assetHref({ kind: "eventSpec", id: "s1", domainSlug: "payments", productSlug: "checkout" }, { version: "2.0" })).toBe(
      "/schemas/payments/checkout/specs/s1?version=2.0"
    );
    expect(assetHref({ kind: "message", id: "m 1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/messages/m%201");
    expect(assetHref({ kind: "channel", id: "c1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/channels/c1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments/traits/t1");
    expect(assetHref({ kind: "traits", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise?tab=traits");
  });
});
