import { describe, it, expect } from "vitest";
import { getDefaultMapping } from "@/lib/type-mapping/default-mappings";

describe("Avro decimal mapping notes (final review C-I4)", () => {
  // The Avro emitter (separate typespec repo) hardcodes decimal(precision 38, scale 0) for these scalars.
  it.each(["decimal", "decimal128", "numeric"])("%s → bytes/decimal is flagged lossy with the real published precision", (sourceType) => {
    const row = getDefaultMapping(sourceType, "avro");
    expect(row?.mappedType).toBe("bytes/decimal");
    expect(row?.isLossy).toBe(true);
    expect(row?.lossDescription).toMatch(/decimal\(precision 38, scale 0\)/);
    expect(row?.lossDescription).toMatch(/decimal\(12,2\)/);
  });
});
