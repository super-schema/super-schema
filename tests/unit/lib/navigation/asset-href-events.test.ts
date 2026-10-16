import { describe, it, expect } from "vitest";
import { assetHref, TRAITS_SEGMENT } from "@/lib/navigation/asset-href";
import * as assetHrefModule from "@/lib/navigation/asset-href";

describe("assetHref — events kinds", () => {
  it("links the product Events tab without a section (the flat Events list has no sections)", () => {
    const href = assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" });
    expect(href).toBe("/schemas/payments/checkout?tab=events");
    expect(href).not.toContain("section=");
  });

  it("encodes slugs and carries version and extra query on the Events tab link", () => {
    expect(assetHref({ kind: "events", domainSlug: "pay ments", productSlug: "check out" })).toBe("/schemas/pay%20ments/check%20out?tab=events");
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" }, { version: "2.0" })).toBe(
      "/schemas/payments/checkout?tab=events&version=2.0"
    );
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" }, { query: { created: "1" } })).toBe(
      "/schemas/payments/checkout?tab=events&created=1"
    );
  });

  it("does not change the list href when event-page options are passed", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" }, { tab: "docs", section: "channels", item: "orders" })).toBe(
      "/schemas/payments/checkout?tab=events"
    );
  });

  it("links the self-contained event page and the library trait pages (Domain and Enterprise only)", () => {
    expect(assetHref({ kind: "event", id: "e1", domainSlug: "payments", productSlug: "checkout" }, { version: "2.0" })).toBe(
      "/schemas/payments/checkout/events/e1?version=2.0"
    );
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments" })).toBe("/schemas/payments/traits/t1");
    expect(assetHref({ kind: "traits", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise?tab=traits");
  });
});

describe("retired catalog URL helpers", () => {
  it("keeps the trait segment and no longer exports the message / channel / spec segments or section helpers", () => {
    expect(TRAITS_SEGMENT).toBe("traits");
    expect("EVENT_SEGMENT" in assetHrefModule).toBe(false);
    expect("normalizeEventsSection" in assetHrefModule).toBe(false);
  });
});
