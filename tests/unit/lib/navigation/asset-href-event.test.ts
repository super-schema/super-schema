import { describe, it, expect } from "vitest";
import {
  assetHref, BUILDER_SECTIONS, EVENT_TABS, normalizeBuilderSection, normalizeEventTab,
  type BuilderSection, type EventTab,
} from "@/lib/navigation/asset-href";

const at = { domainSlug: "d", productSlug: "p" };

describe("assetHref — event kind", () => {
  it("links the event page", () => {
    expect(assetHref({ kind: "event", id: "id", ...at })).toBe("/schemas/d/p/events/id");
  });

  it("carries tab, section and item as query params, in that order", () => {
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: "docs", section: "channels", item: "orders" })).toBe(
      "/schemas/d/p/events/id?tab=docs&section=channels&item=orders"
    );
  });

  it("omits params that are the default or undefined", () => {
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: "design", section: "metadata" })).toBe("/schemas/d/p/events/id");
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: undefined, section: undefined, item: undefined })).toBe("/schemas/d/p/events/id");
    expect(assetHref({ kind: "event", id: "id", ...at }, { item: "" })).toBe("/schemas/d/p/events/id");
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: "design", section: "channels" })).toBe("/schemas/d/p/events/id?section=channels");
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: "docs", section: "metadata" })).toBe("/schemas/d/p/events/id?tab=docs");
    expect(assetHref({ kind: "event", id: "id", ...at }, { item: "orders" })).toBe("/schemas/d/p/events/id?item=orders");
  });

  it("encodes the id, the slugs and the item", () => {
    expect(assetHref({ kind: "event", id: "e 1/x", domainSlug: "pay ments", productSlug: "check out" })).toBe(
      "/schemas/pay%20ments/check%20out/events/e%201%2Fx"
    );
    const href = assetHref({ kind: "event", id: "id", ...at }, { section: "servers", item: "a b&c=d" });
    expect(href).toBe("/schemas/d/p/events/id?section=servers&item=a+b%26c%3Dd");
    expect(new URL(href, "http://x").searchParams.get("item")).toBe("a b&c=d");
  });

  it("appends the version and extra query after the event params", () => {
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: "docs", version: "1.0" })).toBe("/schemas/d/p/events/id?tab=docs&version=1.0");
    expect(assetHref({ kind: "event", id: "id", ...at }, { section: "messages", query: { x: "1" } })).toBe("/schemas/d/p/events/id?section=messages&x=1");
  });

  it("ignores tab, section and item for every other kind", () => {
    const opts = { tab: "docs", section: "channels", item: "orders" } as const;
    expect(assetHref({ kind: "product", ...at }, opts)).toBe("/schemas/d/p");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "d" }, opts)).toBe("/schemas/d/traits/t1");
    expect(assetHref({ kind: "events", ...at }, opts)).toBe(assetHref({ kind: "events", ...at }));
  });

  it("writes the Docs tab as ?tab=docs and still reads the retired ?tab=preview as Docs", () => {
    const href = assetHref({ kind: "event", id: "id", ...at }, { tab: "docs" });
    expect(href).toBe("/schemas/d/p/events/id?tab=docs");
    expect(normalizeEventTab(new URL(href, "http://x").searchParams.get("tab"))).toBe("docs");
    expect(normalizeEventTab("preview")).toBe("docs");
    expect(assetHref({ kind: "event", id: "id", ...at }, { tab: normalizeEventTab("preview") })).toBe(href);
  });

  it("round-trips every tab and section through the normalizers", () => {
    for (const tab of EVENT_TABS) {
      for (const section of BUILDER_SECTIONS) {
        const url = new URL(assetHref({ kind: "event", id: "id", ...at }, { tab, section }), "http://x");
        expect(normalizeEventTab(url.searchParams.get("tab"))).toBe(tab);
        expect(normalizeBuilderSection(url.searchParams.get("section"))).toBe(section);
      }
    }
  });
});

describe("assetHref — existing kinds are untouched by the event kind", () => {
  it("keeps the events list ref on the product Events tab", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=events");
  });

  it("keeps the other detail pages", () => {
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "product", ...at })).toBe("/schemas/d/p");
    expect(assetHref({ kind: "newEntity", ...at })).toBe("/schemas/d/p/new");
  });
});

describe("event tabs and builder sections", () => {
  it("exposes the Design and Docs tabs and the seven builder sections", () => {
    expect([...EVENT_TABS]).toEqual(["design", "docs"]);
    expect([...BUILDER_SECTIONS]).toEqual(["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"]);
  });

  it("writes and reads the traits and advanced sections", () => {
    for (const section of ["traits", "advanced"] as const) {
      const href = assetHref({ kind: "event", id: "id", ...at }, { section, item: "idempotent" });
      expect(href).toBe(`/schemas/d/p/events/id?section=${section}&item=idempotent`);
      expect(normalizeBuilderSection(new URL(href, "http://x").searchParams.get("section"))).toBe(section);
    }
  });

  it("an old or unknown ?section= value still falls back to metadata", () => {
    for (const old of ["trait", "security", "components", "Traits", "ADVANCED", "traits ", "bogus", ""]) {
      expect(normalizeBuilderSection(old), old).toBe("metadata");
    }
  });

  it("normalizes ?tab=, aliasing the old spec tabs and the retired preview tab, defaulting to design", () => {
    const cases: Array<[string | null | undefined, EventTab]> = [
      ["design", "design"], ["docs", "docs"],
      ["editor", "design"], ["preview", "docs"], ["document", "docs"], ["diagnostics", "docs"],
      ["bogus", "design"], ["", "design"], [null, "design"], [undefined, "design"],
      ["Docs", "design"], [" docs", "design"], ["Preview", "design"], [" preview", "design"],
      ["constructor", "design"], ["toString", "design"], ["__proto__", "design"],
    ];
    for (const [input, expected] of cases) expect(normalizeEventTab(input), String(input)).toBe(expected);
  });

  it("answers design for a value that is not a string at all", () => {
    expect(normalizeEventTab(["docs"] as unknown as string)).toBe("design");
    expect(normalizeEventTab(["preview"] as unknown as string)).toBe("design");
    expect(normalizeEventTab(5 as unknown as string)).toBe("design");
  });

  it("normalizes ?section=, defaulting to metadata", () => {
    const cases: Array<[string | null | undefined, BuilderSection]> = [
      ["metadata", "metadata"], ["servers", "servers"], ["channels", "channels"], ["messages", "messages"], ["operations", "operations"],
      ["bogus", "metadata"], ["", "metadata"], [null, "metadata"], [undefined, "metadata"],
      ["traits", "traits"], ["advanced", "advanced"],
      ["Channels", "metadata"], ["Traits", "metadata"], ["Advanced", "metadata"],
      ["constructor", "metadata"], ["__proto__", "metadata"],
    ];
    for (const [input, expected] of cases) expect(normalizeBuilderSection(input), String(input)).toBe(expected);
  });

  it("answers metadata for a value that is not a string at all", () => {
    expect(normalizeBuilderSection(["channels"] as unknown as string)).toBe("metadata");
  });
});
