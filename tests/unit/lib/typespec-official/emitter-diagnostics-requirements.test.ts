import { describe, expect, it } from "vitest";
import { requirementFromDiagnostic, structuredDiagnostics } from "@/lib/typespec-official/emitter-diagnostics";

const RAW = "@typespec/bigquery/missing-primary-key: Table 'ImportedEntity' must have at least one @primaryKey property.";
const SHAPE = {
  name: "ImportedEntity",
  fields: [
    { name: "tenant", isKey: false, nullable: false, type: "string" },
    { name: "note", isKey: false, nullable: true, type: "string" },
  ],
};

describe("structuredDiagnostics", () => {
  it("splits the extracted `<code>: <message>` form", () => {
    expect(structuredDiagnostics(RAW)).toEqual([
      { code: "@typespec/bigquery/missing-primary-key", message: "Table 'ImportedEntity' must have at least one @primaryKey property." },
    ]);
  });

  it("reads the error lines of a whole compile, ignoring warnings and the banner", () => {
    const raw =
      "TypeSpec compiler v1.10.0\n/tmp/x/main.tsp:1:1 - warning deprecated: old\n" +
      "/tmp/x/main.tsp:8:7 - error @typespec/postgres/missing-primary-key: Table 'T' must have at least one @primaryKey property.\n" +
      "/tmp/x/main.tsp:9:7 - error invalid-ref: Unknown identifier x\nFound 2 errors.";
    expect(structuredDiagnostics(raw).map((d) => d.code)).toEqual(["@typespec/postgres/missing-primary-key", "invalid-ref"]);
  });

  it("returns nothing for text without a diagnostic", () => {
    expect(structuredDiagnostics("The TypeSpec emitter failed.")).toEqual([]);
  });
});

describe("requirementFromDiagnostic", () => {
  it.each(["bigquery", "postgres", "spanner"])("maps @typespec/%s/missing-primary-key to the primary-key requirement", (pkg) => {
    const [diagnostic] = structuredDiagnostics(RAW.replace("bigquery", pkg));
    const requirement = requirementFromDiagnostic(diagnostic, SHAPE);
    expect(requirement?.code).toBe("primary-key");
    expect(requirement?.candidates).toEqual(["tenant", "note"]);
    expect(requirement?.suggested).toEqual(["tenant"]);
  });

  it("leaves every other diagnostic untouched", () => {
    for (const code of ["@typespec/spanner/invalid-interleave-pk", "invalid-ref", "@typespec/bigquery/index-not-supported"]) {
      expect(requirementFromDiagnostic({ code, message: "x" }, SHAPE)).toBeNull();
    }
  });
});
