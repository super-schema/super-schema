import { describe, expect, it } from "vitest";
import { assetHref } from "@/lib/navigation/asset-href";

const field = { kind: "field", entitySlug: "order", fieldId: "f1", domainSlug: "payments", productSlug: "checkout" } as const;

describe("assetHref: the query a caller hands over (a page's search params go through unchanged)", () => {
  it("writes a string value as before, in the order given, after the kind's own query", () => {
    expect(assetHref({ kind: "dataTypes", domainSlug: "payments", productSlug: "checkout" }, { query: { a: "1", b: "2" } })).toBe(
      "/schemas/payments/checkout?tab=data-types&a=1&b=2",
    );
  });

  it("writes every value of a repeated key (Next gives a search param that appears twice as a list)", () => {
    expect(assetHref(field, { query: { tag: ["a", "b"], panel: "governance" } })).toBe(
      "/schemas/payments/checkout/order/fields/f1?tag=a&tag=b&panel=governance",
    );
  });

  it("leaves out a key without a value (undefined) and a key with an empty list", () => {
    expect(assetHref(field, { query: { panel: undefined, tag: [], version: "1.2.0" } })).toBe(
      "/schemas/payments/checkout/order/fields/f1?version=1.2.0",
    );
  });

  it("encodes what needs it", () => {
    expect(assetHref(field, { query: { q: "a b&c" } })).toBe("/schemas/payments/checkout/order/fields/f1?q=a+b%26c");
  });

  it("a `version` option still wins over a `version` of the query", () => {
    expect(assetHref(field, { query: { version: "old" }, version: "new" })).toBe("/schemas/payments/checkout/order/fields/f1?version=new");
  });
});
