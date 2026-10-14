import { describe, expect, it } from "vitest";
import { entityHref } from "@/features/compliance/ComplianceResultsTable";
import { gapHref } from "@/features/compliance/ComplianceGapsView";
import type { ComplianceFieldResult, ComplianceGap } from "@/types/schemas/compliance";

const field = (overrides: Partial<ComplianceFieldResult> = {}) =>
  ({
    entityId: "ent-1",
    entityName: "Customer",
    entitySlug: "customer",
    fieldId: "fld-1",
    fieldName: "email",
    ...overrides,
  }) as ComplianceFieldResult;

const gap = (overrides: Partial<ComplianceGap> = {}) =>
  ({
    entityId: "ent-1",
    entityName: "Customer",
    entitySlug: "customer",
    fieldId: "fld-1",
    fieldName: "email",
    gapType: "UNCLASSIFIED",
    severity: "CRITICAL",
    suggestedFix: "",
    ...overrides,
  }) as ComplianceGap;

describe("compliance results entityHref", () => {
  it("links a placed entity through assetHref", () => {
    expect(entityHref(field({ domainSlug: "commerce", productSlug: "orders" }))).toBe(
      "/schemas/commerce/orders/customer"
    );
  });

  it("links a tenant-level entity (null slugs) to its Enterprise route", () => {
    expect(entityHref(field({ domainSlug: null, productSlug: null }))).toBe(
      "/schemas/enterprise/entities/customer"
    );
  });

  it("falls back to the schemas index for a row without route slugs", () => {
    expect(entityHref(field())).toBe("/schemas?entityId=ent-1");
  });
});

describe("compliance gapHref", () => {
  it("opens the matching panel on a placed entity", () => {
    expect(gapHref(gap({ domainSlug: "commerce", productSlug: "orders" }))).toBe(
      "/schemas/commerce/orders/customer?fieldId=fld-1&panel=classification"
    );
  });

  it("opens the policy panel for a retention gap on a tenant-level entity", () => {
    expect(gapHref(gap({ domainSlug: null, productSlug: null, gapType: "NO_RETENTION" }))).toBe(
      "/schemas/enterprise/entities/customer?fieldId=fld-1&panel=policy"
    );
  });

  it("falls back to the schemas index for a gap without route slugs", () => {
    expect(gapHref(gap())).toBe("/schemas?entityId=ent-1&fieldId=fld-1&panel=classification");
  });
});
