import { describe, it, expect } from "vitest";
import { assetHref, EVENT_SEGMENT, normalizeEventsSection, TRAITS_SEGMENT, type EventsSection } from "@/lib/navigation/asset-href";

describe("assetHref — events kinds", () => {
  it("links the product Events tab with a section (default specs)", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=events&section=specs");
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout", section: "channels" })).toBe(
      "/schemas/payments/checkout?tab=events&section=channels"
    );
  });

  it("links every Events section", () => {
    const sections: EventsSection[] = ["specs", "messages", "channels"];
    for (const section of sections) {
      expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout", section })).toBe(
        `/schemas/payments/checkout?tab=events&section=${section}`
      );
    }
  });

  it("encodes slugs and carries version and extra query on the Events tab link", () => {
    expect(assetHref({ kind: "events", domainSlug: "pay ments", productSlug: "check out", section: "messages" })).toBe(
      "/schemas/pay%20ments/check%20out?tab=events&section=messages"
    );
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout", section: "specs" }, { version: "2.0" })).toBe(
      "/schemas/payments/checkout?tab=events&section=specs&version=2.0"
    );
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" }, { query: { section: "channels" } })).toBe(
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

describe("events section / segment helpers", () => {
  it("normalizes ?section= to a known Events section, defaulting to specs", () => {
    expect(normalizeEventsSection("specs")).toBe("specs");
    expect(normalizeEventsSection("messages")).toBe("messages");
    expect(normalizeEventsSection("channels")).toBe("channels");
    expect(normalizeEventsSection(null)).toBe("specs");
    expect(normalizeEventsSection(undefined)).toBe("specs");
    expect(normalizeEventsSection("")).toBe("specs");
    expect(normalizeEventsSection("bogus")).toBe("specs");
    expect(normalizeEventsSection("Messages")).toBe("specs");
  });

  it("exposes the detail-page URL segments the links are built from", () => {
    expect(EVENT_SEGMENT).toEqual({ message: "messages", channel: "channels", eventSpec: "specs" });
    expect(TRAITS_SEGMENT).toBe("traits");
    for (const kind of ["message", "channel", "eventSpec"] as const) {
      expect(assetHref({ kind, id: "x", domainSlug: "d", productSlug: "p" })).toBe(`/schemas/d/p/${EVENT_SEGMENT[kind]}/x`);
    }
  });
});
