/**
 * Exhaustive data-type → target mapping coverage.
 *
 * For every logical scalar/temporal type Super Schema supports, assert a mapping
 * exists to EVERY emission target. This is the "all data types get implemented"
 * guarantee for the type-mapping layer — a new logical type or target that lacks
 * a mapping fails here loudly.
 *
 * Container/complex types (array, map, object, reference, enum) are handled
 * structurally by the emitters, not by scalar mappings — they are covered by the
 * all-types emission round-trip (tests/integration/all-types-roundtrip.test.ts).
 */
import { describe, it, expect } from "vitest";
import { DATA_TYPE_HIERARCHY, isComplexType } from "@/lib/data-types";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";
import { resolveMapping } from "@/lib/type-mapping/mapping-engine";

const TARGETS = ["avro", "bigquery", "openapi", "postgresql", "spanner"] as const;

// enum maps structurally in most targets; exclude it with the other complex types.
const SCALAR_TYPES = DATA_TYPE_HIERARCHY.map((t) => t.id).filter(
  (id) => !isComplexType(id) && id !== "enum"
);

describe("data-type mapping coverage", () => {
  const policies = getDefaultPolicies();

  it("covers every scalar/temporal logical type", () => {
    // Guard: make sure we're actually testing a meaningful set.
    expect(SCALAR_TYPES.length).toBeGreaterThan(20);
  });

  for (const target of TARGETS) {
    describe(`target: ${target}`, () => {
      for (const type of SCALAR_TYPES) {
        it(`maps ${type} → ${target}`, () => {
          const result = resolveMapping(type, target, policies);
          expect(result.success, `no mapping for ${type} → ${target}`).toBe(true);
          if (result.success) {
            expect(result.result.mappedType).toBeTruthy();
          }
        });
      }
    });
  }
});
