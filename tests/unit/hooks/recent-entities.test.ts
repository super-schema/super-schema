/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getRecentEntityIds,
  getRecentEntityEntries,
  trackRecentEntity,
  clearRecentEntities,
  hasStoredEntityLocation,
} from "@/lib/recent-entities";

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } satisfies Storage;

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("Recent Entity Tracking", () => {
  beforeEach(() => {
    installLocalStorage();
    localStorage.clear();
  });

  it("should return empty array when no recent entities exist", () => {
    expect(getRecentEntityIds()).toEqual([]);
    expect(getRecentEntityEntries()).toEqual([]);
  });

  it("should track a single entity", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "core",
      entityName: "Customer",
      domainName: "Core",
    });

    expect(getRecentEntityIds()).toEqual(["e1"]);
    expect(getRecentEntityEntries()).toHaveLength(1);
    expect(getRecentEntityEntries()[0].entityName).toBe("Customer");
  });

  it("should add most recent entity first", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "core",
      entityName: "Customer",
      domainName: "Core",
    });
    trackRecentEntity({
      entityId: "e2",
      domainSlug: "core",
      entityName: "Order",
      domainName: "Core",
    });

    expect(getRecentEntityIds()).toEqual(["e2", "e1"]);
  });

  it("should deduplicate — re-tracking moves to front", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "core",
      entityName: "Customer",
      domainName: "Core",
    });
    trackRecentEntity({
      entityId: "e2",
      domainSlug: "core",
      entityName: "Order",
      domainName: "Core",
    });
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "core",
      entityName: "Customer",
      domainName: "Core",
    });

    expect(getRecentEntityIds()).toEqual(["e1", "e2"]);
    expect(getRecentEntityEntries()).toHaveLength(2);
    expect(getRecentEntityEntries()[0].entityId).toBe("e1");
  });

  it("should limit to 5 recent entities", () => {
    for (let i = 1; i <= 7; i++) {
      trackRecentEntity({
        entityId: `e${i}`,
        domainSlug: "core",
        entityName: `Entity${i}`,
        domainName: "Core",
      });
    }

    const ids = getRecentEntityIds();
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(["e7", "e6", "e5", "e4", "e3"]);
  });

  it("should clear all recent entities", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "core",
      entityName: "Customer",
      domainName: "Core",
    });
    clearRecentEntities();

    expect(getRecentEntityIds()).toEqual([]);
    expect(getRecentEntityEntries()).toEqual([]);
  });

  it("should handle corrupted localStorage data gracefully", () => {
    localStorage.setItem("super-schema:recent-entities", "not-json");
    expect(getRecentEntityIds()).toEqual([]);

    localStorage.setItem("super-schema:recent-entity-entries", "{invalid");
    expect(getRecentEntityEntries()).toEqual([]);
  });

  it("should preserve entry data across tracks", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "finance",
      entityName: "Transaction",
      domainName: "Finance",
    });

    const entries = getRecentEntityEntries();
    expect(entries[0]).toEqual({
      entityId: "e1",
      domainSlug: "finance",
      entityName: "Transaction",
      domainName: "Finance",
    });
  });

  it("round-trips slug and productSlug for product-level and tenant-level entities", () => {
    trackRecentEntity({
      entityId: "e1",
      domainSlug: "payments",
      entityName: "Order",
      domainName: "Payments",
      slug: "order",
      productSlug: "checkout",
    });
    trackRecentEntity({
      entityId: "e0",
      domainSlug: null,
      entityName: "Customer",
      domainName: "Enterprise",
      slug: "customer",
      productSlug: null,
    });

    const [tenant, product] = getRecentEntityEntries();
    expect(product).toMatchObject({ slug: "order", productSlug: "checkout", domainSlug: "payments" });
    expect(tenant).toMatchObject({ slug: "customer", productSlug: null, domainSlug: null });
    expect(hasStoredEntityLocation(product)).toBe(true);
    expect(hasStoredEntityLocation(tenant)).toBe(true);
  });

  it("does not treat a legacy entry without a stored slug as navigable", () => {
    localStorage.setItem(
      "super-schema:recent-entity-entries",
      JSON.stringify([
        { entityId: "e1", domainSlug: "payments", entityName: "Order", domainName: "Payments" },
      ])
    );

    const [legacy] = getRecentEntityEntries();
    expect(legacy.slug).toBeUndefined();
    expect(hasStoredEntityLocation(legacy)).toBe(false);
  });

  it("does not throw when storage refuses writes (private browsing, full quota), so an entity page keeps rendering", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        },
        removeItem: () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
        clear: () => undefined,
      },
    });

    expect(() =>
      trackRecentEntity({
        entityId: "e1",
        domainSlug: "core",
        entityName: "Customer",
        domainName: "Core",
      })
    ).not.toThrow();
    expect(() => clearRecentEntities()).not.toThrow();
  });
});
