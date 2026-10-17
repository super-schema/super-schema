import { describe, it, expect } from "vitest";
import { assetHref, EVENT_TABS, nextEventTab, normalizeEventTab, type EventTab } from "@/lib/navigation/asset-href";

const at = { domainSlug: "d", productSlug: "p" };
const ref = { kind: "event", id: "id", ...at } as const;

describe("event page tabs: Versions and Used by", () => {
  it("has four tabs, in the order the page shows them", () => {
    expect([...EVENT_TABS]).toEqual(["design", "docs", "versions", "used-by"]);
  });

  it("reads ?tab=versions and ?tab=used-by", () => {
    expect(normalizeEventTab("versions")).toBe("versions");
    expect(normalizeEventTab("used-by")).toBe("used-by");
  });

  it("still falls back to Design for anything unknown (also near-misses of the new names)", () => {
    for (const value of ["", "nonsense", "used_by", "usedby", "Versions", "version", null, undefined]) {
      expect(normalizeEventTab(value), String(value)).toBe("design");
    }
  });

  it("keeps every old alias", () => {
    expect(normalizeEventTab("editor")).toBe("design");
    expect(normalizeEventTab("preview")).toBe("docs");
    expect(normalizeEventTab("document")).toBe("docs");
    expect(normalizeEventTab("diagnostics")).toBe("docs");
  });

  it("writes the two tabs as ?tab=, with the version after the event params", () => {
    expect(assetHref(ref, { tab: "versions" })).toBe("/schemas/d/p/events/id?tab=versions");
    expect(assetHref(ref, { tab: "used-by" })).toBe("/schemas/d/p/events/id?tab=used-by");
    expect(assetHref(ref, { tab: "versions", version: "1.1" })).toBe("/schemas/d/p/events/id?tab=versions&version=1.1");
  });

  it("round-trips every tab through the URL", () => {
    for (const tab of EVENT_TABS) {
      const url = new URL(assetHref(ref, { tab }), "http://x");
      expect(normalizeEventTab(url.searchParams.get("tab")), tab).toBe(tab);
    }
  });
});

describe("nextEventTab (keyboard navigation of the tab list)", () => {
  it("cycles forward through all four tabs with ArrowRight and wraps", () => {
    const seen: EventTab[] = [];
    let tab: EventTab = "design";
    for (let i = 0; i < 4; i++) {
      tab = nextEventTab(tab, "ArrowRight")!;
      seen.push(tab);
    }
    expect(seen).toEqual(["docs", "versions", "used-by", "design"]);
  });

  it("cycles backward with ArrowLeft and wraps", () => {
    const seen: EventTab[] = [];
    let tab: EventTab = "design";
    for (let i = 0; i < 4; i++) {
      tab = nextEventTab(tab, "ArrowLeft")!;
      seen.push(tab);
    }
    expect(seen).toEqual(["used-by", "versions", "docs", "design"]);
  });

  it("jumps to the first and last tab with Home and End", () => {
    expect(nextEventTab("versions", "Home")).toBe("design");
    expect(nextEventTab("versions", "End")).toBe("used-by");
  });

  it("returns null for any other key", () => {
    for (const key of ["a", "Enter", " ", "ArrowUp", "ArrowDown", "Tab"]) expect(nextEventTab("docs", key), key).toBeNull();
  });
});
