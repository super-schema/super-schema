import { describe, expect, it } from "vitest";
import {
  getTargetTypeCatalogEntry,
  getValidTargetTypesFor,
  supportsGeneratedTypeOverrides,
} from "@/lib/type-mapping/target-type-catalog";

describe("target-type-catalog", () => {
  it("includes rich Spanner options sourced from Google Cloud docs", () => {
    const spanner = getTargetTypeCatalogEntry("spanner");

    expect(spanner?.docsUrl).toContain("cloud.google.com/spanner");
    expect(spanner?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["STRING(MAX)", "JSON", "ARRAY<UUID>"])
    );
  });

  it("includes PostgreSQL options sourced from PostgreSQL docs", () => {
    const postgresql = getTargetTypeCatalogEntry("postgresql");

    expect(postgresql?.docsUrl).toContain("postgresql.org/docs/current/datatype");
    expect(getValidTargetTypesFor("postgresql")).toEqual(
      expect.arrayContaining(["jsonb", "timestamptz", "uuid[]"])
    );
  });

  it("tracks which targets support generated field overrides", () => {
    expect(supportsGeneratedTypeOverrides("spanner")).toBe(true);
    expect(supportsGeneratedTypeOverrides("postgresql")).toBe(true);
    expect(supportsGeneratedTypeOverrides("openapi3")).toBe(false);
  });
});
