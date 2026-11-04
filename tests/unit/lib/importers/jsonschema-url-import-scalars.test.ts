import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access/principal", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/action-context", () => ({ sanitizeActionError: async (r: unknown) => r }));

import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import type { ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";

const json = (o: unknown) => JSON.stringify(o);
const BASE = "https://example.com/schemas";
const deps = (files: Record<string, string>): ResolverDeps => ({
  lookup: async () => ["93.184.216.34"],
  fetchHttp: async (url) => {
    if (url in files) return files[url]!;
    throw new Error("HTTP 404");
  },
  fetchGitFile: async () => {
    throw new Error("git must not be called");
  },
});

const FILES = {
  [`${BASE}/party.json`]: json({
    type: "object",
    title: "Party",
    required: ["country"],
    properties: {
      country: { $ref: "country_code.json", description: "Where the party lives." },
      countries: { type: "array", items: { $ref: "country_code.json" } },
      created: { $ref: "date_time.json" },
      score: { $ref: "percentage.json" },
    },
  }),
  [`${BASE}/country_code.json`]: json({ type: "string", title: "CountryCode", description: "ISO 3166-1 alpha-2.", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 }),
  [`${BASE}/date_time.json`]: json({ type: "string", title: "DateTime", format: "date-time" }),
  [`${BASE}/percentage.json`]: json({ type: "integer", title: "Percentage", minimum: 0, maximum: 100 }),
};

describe("a $ref to a primitive-only file is a shared scalar", () => {
  it("creates the scalars and types the fields with them (type, constraints and name copied)", async () => {
    const r = await importJsonSchemaFromUrl(`${BASE}/party.json`, deps(FILES));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const d = r.data;
    expect(d.scalars.map((s) => s.name).sort()).toEqual(["CountryCode", "DateTime", "Percentage"]);
    const party = d.entities.find((e) => e.name === "Party")!;
    const f = (n: string) => party.fields.find((x) => x.name === n)!;

    expect(f("country")).toMatchObject({ type: "string", scalarName: "CountryCode", format: undefined, description: "Where the party lives." });
    expect(f("country").referencedEntityName).toBeUndefined();
    expect(f("country").danglingRef).toBeUndefined();
    expect(f("country").constraints).toEqual(expect.arrayContaining([{ type: "pattern", value: "^[A-Z]{2}$" }, { type: "maxLength", value: 2 }]));

    expect(f("countries")).toMatchObject({ type: "array", arrayElementType: "string", scalarName: "CountryCode" });
    expect(f("created").scalarName).toBe("DateTime");
    expect(f("created").type).not.toBe("reference");
    expect(f("score")).toMatchObject({ scalarName: "Percentage" });
    expect(f("score").constraints).toEqual(expect.arrayContaining([{ type: "minValue", value: 0 }, { type: "maxValue", value: 100 }]));
    expect(d.warnings.join("\n")).not.toMatch(/could not be loaded|no properties/);
  });

  it("a scalar file that is the root itself imports as one scalar", async () => {
    const r = await importJsonSchemaFromUrl(`${BASE}/country_code.json`, deps(FILES));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities).toHaveLength(0);
    expect(r.data.scalars.map((s) => s.name)).toEqual(["CountryCode"]);
  });

  it("each file's root asset remembers the file it came from, so a later $ref to the file finds it whatever its title", async () => {
    const files = {
      ...FILES,
      [`${BASE}/crypto_decimals.json`]: json({ type: "integer", title: "Decimals", minimum: 0, maximum: 40 }),
      [`${BASE}/gender.json`]: json({ type: "string", title: "Gender Type", "x-enum": [{ value: "MALE", description: "m" }] }),
      [`${BASE}/holder.json`]: json({ type: "object", title: "Holder", properties: { d: { $ref: "crypto_decimals.json" }, g: { $ref: "gender.json" } } }),
    };
    const r = await importJsonSchemaFromUrl(`${BASE}/holder.json`, deps(files));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.scalars.find((s) => s.name === "Decimals")?.sourceRef).toBe("crypto_decimals");
    // a display title is no name: the enum is named by its file
    expect(r.data.enums.map((e) => e.name)).toEqual(["gender"]);
    expect(r.data.enums[0].sourceRef).toBe("gender");
    expect(r.data.entities[0].sourceRef).toBe("holder");
  });
});
