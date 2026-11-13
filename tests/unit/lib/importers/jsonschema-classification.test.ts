import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import {
  getClassificationConfig,
  resetClassificationConfigWarnings,
} from "@/lib/importers/classification-config";

const KEY = "x-securityClassification";
const ENV_VARS = [
  "SCHEMA_CLASSIFICATION_EXTENSION_KEY",
  "SCHEMA_CLASSIFICATION_LEVEL_FIELD",
  "SCHEMA_CLASSIFICATION_CATEGORY_FIELD",
  "SCHEMA_CLASSIFICATION_VALUE_MAP",
];

function data(result: ReturnType<typeof parseJsonSchemaDocument>) {
  if (!result.success) throw new Error("import failed");
  return result.data;
}
function importProps(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return data(parseJsonSchemaDocument(JSON.stringify({ title: "Thing", type: "object", properties, ...extra })));
}
function field(doc: ReturnType<typeof importProps>, name: string) {
  const f = doc.entities[0]?.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  resetClassificationConfigWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const v of ENV_VARS) delete process.env[v];
  warn.mockRestore();
});

describe("classification import: default key", () => {
  it("(1) maps data_class to classification, keeps category, and keeps the block in extensions", () => {
    const block = { data_class: "class4", data_category: "Intrinsic" };
    const f = field(importProps({ a: { type: "string", [KEY]: block } }), "a");
    expect(f.classification).toBe("INTERNAL");
    expect(f.extensions?.[KEY]).toEqual(block);
  });

  it("maps a raw classN level onto the system level of its class", () => {
    const block = { data_class: "class2", data_category: "ConsumerPersonal" };
    const f = field(importProps({ a: { type: "string", [KEY]: block } }), "a");
    expect(f.classification).toBe("PII");
    expect(f.extensions?.[KEY]).toEqual(block);
    const levels = ["class1", "CLASS3", "Class5", "restricted", "class6", "class"].map(
      (data_class, i) => field(importProps({ [`p${i}`]: { type: "string", [KEY]: { data_class } } }), `p${i}`).classification,
    );
    expect(levels).toEqual(["NEVER_STORED", "SENSITIVE", "PUBLIC", "restricted", "class6", "class"]);
  });

  it("an explicit value-map entry wins over the classN mapping; an unmapped level stays raw", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", '{"class2":"SENSITIVE"}');
    const doc = importProps({
      a: { type: "string", [KEY]: { data_class: "class2" } },
      b: { type: "string", [KEY]: { data_class: "restricted" } },
    });
    expect(field(doc, "a").classification).toBe("SENSITIVE");
    expect(field(doc, "b").classification).toBe("restricted");
  });

  it("trims the level and works for $defs entity properties", () => {
    const doc = data(
      parseJsonSchemaDocument(
        JSON.stringify({
          $defs: { Inner: { type: "object", properties: { s: { type: "string", [KEY]: { data_class: "  c1  " } } } } },
          type: "object",
          properties: { i: { $ref: "#/$defs/Inner" } },
        }),
      ),
    );
    const inner = doc.entities.find((e) => e.name === "Inner");
    expect(inner?.fields[0]?.classification).toBe("c1");
  });

  it("(5) malformed blocks never throw and yield no classification", () => {
    const hostile = JSON.parse('{"__proto__":{"data_class":"x"},"constructor":{"data_class":"y"}}') as Record<
      string,
      unknown
    >;
    const cases: Record<string, unknown> = {
      notObject: "class4",
      number: 4,
      nul: null,
      array: [{ data_class: "class4" }],
      missingLevel: { data_category: "Intrinsic" },
      nonStringLevel: { data_class: 4 },
      emptyLevel: { data_class: "" },
      whitespaceLevel: { data_class: "   " },
      nestedLevel: { data_class: { value: "class4" } },
      protoKeys: hostile,
    };
    const properties: Record<string, unknown> = {};
    for (const [name, block] of Object.entries(cases)) properties[name] = { type: "string", [KEY]: block };
    const doc = importProps(properties);
    for (const name of Object.keys(cases)) {
      const f = field(doc, name);
      expect(f.classification, name).toBeUndefined();
      expect(f.governance?.dataClass, name).toBeUndefined();
    }
  });

  it("a __proto__ own key inside a valid block is harmless", () => {
    const raw = `{"type":"object","properties":{"a":{"type":"string","${KEY}":{"data_class":"c","__proto__":{"polluted":true}}}}}`;
    const f = field(data(parseJsonSchemaDocument(raw)), "a");
    expect(f.classification).toBe("c");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a category that is not a non-empty string is dropped", () => {
    const doc = importProps({
      a: { type: "string", [KEY]: { data_class: "c", data_category: "" } },
      b: { type: "string", [KEY]: { data_class: "c", data_category: 3 } },
    });
    expect(field(doc, "a").governance?.dataCategory).toBeUndefined();
    expect(field(doc, "b").governance?.dataCategory).toBeUndefined();
    expect(field(doc, "a").classification).toBe("c");
  });
});

describe("classification import: configuration", () => {
  it("(2) the value map translates the level; dataClass stays raw", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", '{"class4":"PII"}');
    const doc = importProps({
      a: { type: "string", [KEY]: { data_class: "class4" } },
      b: { type: "string", [KEY]: { data_class: "other" } },
    });
    expect(field(doc, "a").classification).toBe("PII");
    expect(field(doc, "b").classification).toBe("other");
  });

  it("(3) a custom extension key is the only key read; the default key is then just an extension", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_EXTENSION_KEY", "x-dataClass");
    const doc = importProps({
      a: { type: "string", "x-dataClass": { data_class: "c9" } },
      b: { type: "string", [KEY]: { data_class: "class4" } },
    });
    expect(field(doc, "a").classification).toBe("c9");
    expect(field(doc, "a").extensions?.["x-dataClass"]).toEqual({ data_class: "c9" });
    expect(field(doc, "b").classification).toBeUndefined();
    expect(field(doc, "b").extensions?.[KEY]).toEqual({ data_class: "class4" });
  });

  it("(4) level / category field names are configurable", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_LEVEL_FIELD", "level");
    vi.stubEnv("SCHEMA_CLASSIFICATION_CATEGORY_FIELD", "category");
    const f = field(importProps({ a: { type: "string", [KEY]: { level: "c3", category: "Cat" } } }), "a");
    expect(f.classification).toBe("c3");
    expect(f.extensions?.[KEY]).toEqual({ level: "c3", category: "Cat" });
  });

  it("a configured key equal to a reserved key is not read (reserved keys win)", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_EXTENSION_KEY", "x-tags");
    const f = field(importProps({ a: { type: "string", "x-tags": { data_class: "c" } } }), "a");
    expect(f.classification).toBeUndefined();
  });

  it("(6) invalid map JSON, array JSON and non-string values fall back to defaults with one warning", () => {
    for (const bad of ["{nope", "[1,2]", '{"a":1}']) {
      resetClassificationConfigWarnings();
      warn.mockClear();
      vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", bad);
      const doc = importProps({
        a: { type: "string", [KEY]: { data_class: "x" } },
        b: { type: "string", [KEY]: { data_class: "y" } },
      });
      expect(field(doc, "a").classification).toBe("x");
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});

describe("classification config module", () => {
  it("(10) defaults", () => {
    const c = getClassificationConfig({});
    expect(c).toMatchObject({
      extensionKey: "x-securityClassification",
      levelField: "data_class",
      categoryField: "data_category",
    });
    expect(Object.keys(c.valueMap)).toEqual([]);
  });

  it("overrides, trimming", () => {
    const c = getClassificationConfig({
      SCHEMA_CLASSIFICATION_EXTENSION_KEY: "  x-k ",
      SCHEMA_CLASSIFICATION_LEVEL_FIELD: " lv",
      SCHEMA_CLASSIFICATION_CATEGORY_FIELD: "cat ",
      SCHEMA_CLASSIFICATION_VALUE_MAP: ' {" a ":" B "} ',
    });
    expect(c).toMatchObject({ extensionKey: "x-k", levelField: "lv", categoryField: "cat" });
    expect(c.valueMap.a).toBe("B");
  });

  it("rejects empty, over-long and control-char names (defaults + warning)", () => {
    const c = getClassificationConfig({
      SCHEMA_CLASSIFICATION_EXTENSION_KEY: "   ",
      SCHEMA_CLASSIFICATION_LEVEL_FIELD: "x".repeat(101),
      SCHEMA_CLASSIFICATION_CATEGORY_FIELD: "a\nb",
    });
    expect(c.extensionKey).toBe("x-securityClassification");
    expect(c.levelField).toBe("data_class");
    expect(c.categoryField).toBe("data_category");
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("limits the value map to 200 entries and non-empty strings", () => {
    const big = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, "v"]));
    expect(
      Object.keys(getClassificationConfig({ SCHEMA_CLASSIFICATION_VALUE_MAP: JSON.stringify(big) }).valueMap),
    ).toEqual([]);
    expect(Object.keys(getClassificationConfig({ SCHEMA_CLASSIFICATION_VALUE_MAP: '{"a":"  "}' }).valueMap)).toEqual(
      [],
    );
    const ok = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "v"]));
    expect(
      Object.keys(getClassificationConfig({ SCHEMA_CLASSIFICATION_VALUE_MAP: JSON.stringify(ok) }).valueMap),
    ).toHaveLength(200);
  });

  it("hostile map keys stay own data and never touch prototypes", () => {
    const c = getClassificationConfig({
      SCHEMA_CLASSIFICATION_VALUE_MAP: '{"__proto__":"A","constructor":"B","toString":"C"}',
    });
    expect(Object.getPrototypeOf(c.valueMap)).toBeNull();
    expect(Object.hasOwn(c.valueMap, "__proto__")).toBe(true);
    expect(c.valueMap.constructor).toBe("B");
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("hostile levels in a document are looked up as own keys only", () => {
    vi.stubEnv("SCHEMA_CLASSIFICATION_VALUE_MAP", '{"a":"A"}');
    const doc = importProps({
      p: { type: "string", [KEY]: { data_class: "__proto__" } },
      c: { type: "string", [KEY]: { data_class: "constructor" } },
    });
    expect(field(doc, "p").classification).toBe("__proto__");
    expect(field(doc, "c").classification).toBe("constructor");
  });
});

describe("classification import: allOf and x-classification", () => {
  it("reads the block from an annotation-only allOf member; the property's own block wins", () => {
    const doc = importProps({
      viaMember: { allOf: [{ type: "string" }, { [KEY]: { data_class: "m1", data_category: "M" } }] },
      both: {
        allOf: [{ type: "string" }, { [KEY]: { data_class: "member" } }],
        [KEY]: { data_class: "own", data_category: "Own" },
      },
    });
    expect(field(doc, "viaMember").classification).toBe("m1");
    expect(field(doc, "both").classification).toBe("own");
  });

  it("(9) a plain-string x-classification (the app's own export) maps to the classification", () => {
    const doc = importProps({
      a: { type: "string", "x-classification": "PII" },
      b: { type: "string", "x-classification": { nested: 1 } },
      c: { type: "string", "x-classification": "  " },
      d: { type: "string", "x-classification": "legacy", [KEY]: { data_class: "class4" } },
    });
    expect(field(doc, "a").classification).toBe("PII");
    expect(field(doc, "b").classification).toBeUndefined();
    expect(field(doc, "c").classification).toBeUndefined();
    // The vendor block is explicit data classification; it wins over the app's own export key.
    expect(field(doc, "d").classification).toBe("INTERNAL");
    // Still not duplicated into the extensions bag.
    expect(field(doc, "a").extensions).toBeUndefined();
  });
});

const USER_EVENT = `{"type":"object","description":"A user event containing user level customer id information used to link a user across different tenants.","properties":{"component":{"type":"string","description":"Name of the source component logging the user event(s).","minLength":1,"maxLength":100,"pattern":"^([A-Za-z0-9-_])+$","x-securityClassification":{"data_class":"class4","data_category":"Intrinsic"}},"tenant":{"type":"string","description":"Name of the adjacency to Acme.","minLength":1,"maxLength":100,"pattern":"^[a-z0-9_]+$","x-securityClassification":{"data_class":"class4","data_category":"OrgCompany"}},"created_time":{"description":"Event creation timestamp.","$ref":"common_components/v4/schema/json/openapi-2.0/date_time.json","x-securityClassification":{"data_class":"class4","data_category":"Intrinsic"}},"user_links":{"type":"array","description":"List of list of users and their customer ids along with tenant information.","minItems":1,"maxItems":100,"items":{"$ref":"user_links.json"}}},"required":["user_links","created_time","tenant"]}`;

describe("the user's `user event` schema", () => {
  const doc = data(parseJsonSchemaDocument(USER_EVENT));

  it("(7) classifies component, tenant and created_time; user_links stays unclassified", () => {
    const e = doc.entities[0];
    const get = (n: string) => e.fields.find((f) => f.name === n)!;
    expect(get("component").classification).toBe("INTERNAL");
    expect(get("created_time").classification).toBe("INTERNAL");
    expect(get("tenant").classification).toBe("INTERNAL");
    expect(get("tenant").extensions?.[KEY]).toEqual({ data_class: "class4", data_category: "OrgCompany" });
    expect(get("user_links").classification).toBeUndefined();
  });

  it("(8) the classification reaches the persisted field input through the payload chain", () => {
    const r = toAssetImportResult(doc);
    const payload = buildImportAssetsPayload(r, {
      domainId: "d",
      selectedModels: [],
      selectedEntities: r.models.map((_, i) => i),
      selectedEnums: [],
      selectedScalars: [],
      selectedUnions: [],
      selectedServices: [],
      selectedDecorators: [],
    });
    const fields = payload.entities?.[0]?.fields ?? [];
    const tenant = fields.find((f) => f.name === "tenant")!;
    expect(tenant.classification).toBe("INTERNAL");
    const decorators = tenant.decorators as { governance?: Record<string, unknown>; typespec?: { extensions?: { openapi?: Record<string, unknown> } } };
    // The block is the field's extension (the only place the value lives); it no longer leaks into governance.
    expect(decorators.governance?.dataClass).toBeUndefined();
    expect(decorators.governance?.dataCategory).toBeUndefined();
    expect(decorators.typespec?.extensions?.openapi?.[KEY]).toEqual({ data_class: "class4", data_category: "OrgCompany" });
    const unclassified = fields.find((f) => f.name === "user_links")!;
    expect(unclassified.classification).toBeNull();
  });
});
