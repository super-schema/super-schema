import { describe, it, expect } from "vitest";
import { assetHref, ENTERPRISE_ENTITIES_SEGMENT, ENTERPRISE_ROUTE_SEGMENT } from "@/lib/navigation/asset-href";

describe("assetHref", () => {
  it("levels", () => {
    expect(assetHref({ kind: "enterprise" })).toBe("/schemas/enterprise");
    expect(assetHref({ kind: "domain", domainSlug: "payments" })).toBe("/schemas/payments");
    expect(assetHref({ kind: "product", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout");
  });
  it("entities at product and tenant level", () => {
    expect(assetHref({ kind: "entity", slug: "order", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/order");
    expect(assetHref({ kind: "entity", slug: "customer", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/entities/customer");
  });
  it("tenant-level route segments are the ones assetHref emits", () => {
    expect(assetHref({ kind: "entity", slug: "customer", domainSlug: null, productSlug: null })).toBe(
      `/schemas/${ENTERPRISE_ROUTE_SEGMENT}/${ENTERPRISE_ENTITIES_SEGMENT}/customer`
    );
    expect(assetHref({ kind: "enterprise" })).toBe(`/schemas/${ENTERPRISE_ROUTE_SEGMENT}`);
  });
  it("version deep link", () => {
    expect(assetHref({ kind: "entity", slug: "order", domainSlug: "payments", productSlug: "checkout" }, { version: "2.1" }))
      .toBe("/schemas/payments/checkout/order?version=2.1");
  });
  it("data types tab at each level", () => {
    expect(assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise?tab=data-types");
    expect(assetHref({ kind: "dataTypes", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments?tab=data-types");
    expect(assetHref({ kind: "dataTypes", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=data-types");
  });
  it("apis tab at domain and product", () => {
    expect(assetHref({ kind: "apis", domainSlug: "payments", productSlug: null })).toBe("/schemas/payments?tab=apis");
    expect(assetHref({ kind: "apis", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=apis");
  });
  it("events list tab at product has no section param", () => {
    expect(assetHref({ kind: "events", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout?tab=events");
  });
  it("event page", () => {
    expect(assetHref({ kind: "event", id: "ev1", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/events/ev1");
  });
  it("traits at each library level", () => {
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: null })).toBe("/schemas/enterprise/traits/t1");
    expect(assetHref({ kind: "trait", id: "t1", domainSlug: "payments" })).toBe("/schemas/payments/traits/t1");
  });
  it("new entity", () => {
    expect(assetHref({ kind: "newEntity", domainSlug: null, productSlug: null })).toBe("/schemas/enterprise/new");
    expect(assetHref({ kind: "newEntity", domainSlug: "payments", productSlug: "checkout" })).toBe("/schemas/payments/checkout/new");
  });
  it("encodes slugs", () => {
    expect(assetHref({ kind: "domain", domainSlug: "a b" })).toBe("/schemas/a%20b");
  });
});
