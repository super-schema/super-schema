import { describe, it, expect } from "vitest";
import { toFrozenTrait, toResolvedTrait, traitHeadersSubject } from "@/lib/events/catalog-mapping";

const row = (over: Record<string, unknown> = {}) => ({
  id: "t1", name: "CloudEvents", kind: "MESSAGE" as const, spec: { summary: "ce" }, headersEntityId: null, headersEntityVersionId: null,
  tenant: { slug: "acme" }, domain: null, product: null, ...over,
});

describe("library trait mapping", () => {
  it("freezes a trait row; the owner label is the most specific slug (product, domain, then tenant)", () => {
    expect(toFrozenTrait(row({ headersEntityId: "e9" }))).toEqual({
      id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headersEntityId: "e9", headersEntityVersionId: null,
    });
    expect(toFrozenTrait(row({ domain: { slug: "payments" } })).ownerSlug).toBe("payments");
    expect(toFrozenTrait(row({ domain: { slug: "payments" }, product: { slug: "checkout" } })).ownerSlug).toBe("checkout");
  });

  it("treats a malformed stored spec as empty", () => {
    expect(toFrozenTrait(row({ spec: "not an object" })).spec).toEqual({});
    expect(toFrozenTrait(row({ spec: ["x"] })).spec).toEqual({});
  });

  it("renders the headers entity at its pinned version, or its current draft when unpinned, or nothing without a headers entity", () => {
    expect(traitHeadersSubject(toFrozenTrait(row({ headersEntityId: "e9", headersEntityVersionId: "v3" })))).toEqual({ kind: "version", entityVersionId: "v3" });
    expect(traitHeadersSubject(toFrozenTrait(row({ headersEntityId: "e9" })))).toEqual({ kind: "draft", entityId: "e9" });
    expect(traitHeadersSubject(toFrozenTrait(row()))).toBeNull();
  });

  it("resolves a trait without headers, or with the rendered headers artifact", () => {
    const trait = toFrozenTrait(row());
    expect(toResolvedTrait(trait)).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" } });
    const headers = { format: "json-schema" as const, dialect: "2020-12" as const, schema: { type: "object" } };
    expect(toResolvedTrait(trait, headers)).toEqual({ id: "t1", name: "CloudEvents", kind: "MESSAGE", ownerSlug: "acme", spec: { summary: "ce" }, headers });
  });
});
