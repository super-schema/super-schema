import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument, refToEntityName } from "@/lib/importers/jsonschema.importer";
import { detectFormat } from "@/lib/importers/format-detector";
import { importSchemaAssets } from "@/services/import.service";

const parse = (schema: unknown) => {
  const result = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!result.success) throw new Error(result.error.message);
  return result.data;
};

const GENDER = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.com/Gender.v1.json",
  title: "Gender",
  type: "string",
  description: "Person gender.",
  enum: ["MALE", "FEMALE", "PREFER_NOT_TO_SAY"],
  "x-enumDescriptions": { MALE: "m", FEMALE: "f", PREFER_NOT_TO_SAY: "n" },
};

describe("root-level enum", () => {
  it("imports as a shared enum, with no entity", () => {
    const doc = parse(GENDER);
    expect(doc.entities).toEqual([]);
    expect(doc.enums).toHaveLength(1);
    expect(doc.enums[0]).toMatchObject({ name: "Gender", values: ["MALE", "FEMALE", "PREFER_NOT_TO_SAY"], description: "Person gender." });
    expect(doc.enums[0].extensions).toMatchObject({ "x-enumDescriptions": expect.any(Object) });
  });

  it("is named by the $id when there is no title", () => {
    const { title: _title, ...noTitle } = GENDER;
    void _title;
    expect(parse(noTitle).enums[0].name).toBe("Gender");
  });

  it("still refuses a root primitive that is not an enum", () => {
    const result = parseJsonSchemaDocument(JSON.stringify({ title: "RootString", type: "string", minLength: 3 }));
    expect(result.success).toBe(false);
  });

  it("is detected as JSON Schema without a $schema keyword", () => {
    const { $schema: _s, ...bare } = GENDER;
    void _s;
    expect(detectFormat(JSON.stringify(bare), "Gender.v1.json")).toBe("json-schema");
  });

  it("goes to the multi-asset review", () => {
    const route = importSchemaAssets(JSON.stringify(GENDER), "json-schema");
    expect(route.success && route.data.kind).toBe("multi");
  });
});

describe("root-level array", () => {
  const AGREEMENTS = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "ApplicationAgreements.v1.json",
    title: "ApplicationAgreements",
    type: "array",
    description: "Agreement records.",
    minItems: 1,
    items: {
      type: "object",
      required: ["type"],
      properties: { type: { type: "string", enum: ["privacy", "user"] }, uri: { type: "string", format: "uri" } },
    },
  };

  it("imports an array of objects as the element entity, named by the root title", () => {
    const doc = parse(AGREEMENTS);
    expect(doc.entities.map((e) => e.name)).toEqual(["ApplicationAgreements"]);
    expect(doc.entities[0].description).toBe("Agreement records.");
    expect(doc.entities[0].fields.map((f) => f.name)).toEqual(["type", "uri"]);
    expect(doc.rootEntityName).toBe("ApplicationAgreements");
  });

  it("says that the array wrapper is not modelled", () => {
    const doc = parse(AGREEMENTS);
    expect(doc.warnings.some((w) => /root.*array/i.test(w) && /minItems/.test(w))).toBe(true);
  });

  it("imports an array of string enum items as a shared enum", () => {
    const doc = parse({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Address Tags",
      type: "array",
      description: "Tags.",
      items: { type: "string", enum: ["A", "B"], description: "A tag." },
    });
    expect(doc.entities).toEqual([]);
    expect(doc.enums[0]).toMatchObject({ values: ["A", "B"], description: "Tags." });
    expect(doc.warnings.some((w) => /root.*array/i.test(w))).toBe(true);
  });

  it("still refuses an array whose items are neither an object nor a string enum", () => {
    const result = parseJsonSchemaDocument(JSON.stringify({ title: "Nums", type: "array", items: { type: "integer" } }));
    expect(result.success).toBe(false);
  });
});

describe("entity naming", () => {
  const OBJ = { type: "object", properties: { a: { type: "string" } } };

  it("keeps a title that is an identifier", () => {
    expect(parse({ ...OBJ, title: "PlaceOfBirth", $id: "https://x/Other.v1.json" }).entities[0].name).toBe("PlaceOfBirth");
  });

  it("uses the $id file name, without its version, when the title is not an identifier", () => {
    expect(parse({ ...OBJ, title: "Portable Postal Address (Medium-Grained)", $id: "https://x/common/Address.v1.json" }).entities[0].name).toBe("Address");
  });

  it("keeps the title when the $id gives no identifier either", () => {
    expect(parse({ ...OBJ, title: "Some Title", $id: "https://x/some-title.json" }).entities[0].name).toBe("Some Title");
  });

  it("names a reference to a versioned file without the version", () => {
    expect(refToEntityName("../common/PersonName.v1.json")).toBe("PersonName");
    expect(refToEntityName("Address.v12.schema.json")).toBe("Address");
    expect(refToEntityName("order.json")).toBe("order");
  });
});

describe("dictionaries (additionalProperties as a schema)", () => {
  const fieldOf = (prop: unknown) => {
    const doc = parse({ title: "Holder", type: "object", properties: { m: prop } });
    return doc.entities[0].fields[0];
  };

  it("is a map field typed by its value schema", () => {
    const f = fieldOf({ type: "object", description: "d", additionalProperties: { type: "string" } });
    expect(f).toMatchObject({ type: "map", mapKeyType: "string", mapValueType: "string" });
    expect(f.extensions?.additionalProperties).toBeUndefined();
    expect(f.ignoredKeywords ?? []).not.toContain("additionalProperties");
  });

  it("keeps the enum of the values", () => {
    const f = fieldOf({ type: "object", additionalProperties: { type: "string", enum: ["APPROVED", "DECLINED"] } });
    expect(f).toMatchObject({ type: "map", mapValueType: "enum", enumValues: ["APPROVED", "DECLINED"] });
  });

  it("keeps the entity a value refers to", () => {
    const doc = parse({ title: "Holder", type: "object", properties: { m: { type: "object", additionalProperties: { $ref: "#/$defs/Item" } } }, $defs: { Item: { type: "object", properties: { a: { type: "string" } } } } });
    expect(doc.entities[0].fields[0]).toMatchObject({ type: "map", mapValueType: "reference", referencedEntityName: "Item" });
  });

  it("is not a map when the object declares properties, or when additionalProperties is a boolean", () => {
    expect(fieldOf({ type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "string" } }).type).toBe("object");
    expect(fieldOf({ type: "object", additionalProperties: false }).type).toBe("object");
    expect(fieldOf({ type: "object", additionalProperties: true }).type).toBe("object");
  });
});

describe("dictionary whose value schema says more than a type", () => {
  it("is a map and keeps the value schema whole on the field", () => {
    const doc = parse({ title: "H", type: "object", properties: { m: { type: "object", additionalProperties: { type: "string", maxLength: 3 } } } });
    const f = doc.entities[0].fields[0];
    expect(f).toMatchObject({ type: "map", mapValueType: "string" });
    expect(f.extensions?.additionalProperties).toEqual({ type: "string", maxLength: 3 });
  });
});

describe("naming by the file the document came from", () => {
  const withName = (schema: unknown, sourceName?: string) => {
    const result = parseJsonSchemaDocument(JSON.stringify(schema), undefined, sourceName);
    if (!result.success) throw new Error(result.error.message);
    return result.data;
  };
  const OBJ = { type: "object", properties: { a: { type: "string" } } };

  it("uses the file name, without version and extension, when the title is no identifier and there is no $id", () => {
    expect(withName({ ...OBJ, title: "Orthography Type" }, "common/Orthography.v1.json").entities[0].name).toBe("Orthography");
  });

  it("names an enum the same way", () => {
    expect(withName({ title: "Orthography Type", type: "string", enum: ["Latn", "Cyrl"] }, "Orthography.v1.json").enums[0].name).toBe("Orthography");
  });

  it("names an untitled document by its file", () => {
    expect(withName(OBJ, "PersonName.v1.json").entities[0].name).toBe("PersonName");
  });

  it("keeps an identifier title, and the $id before the file", () => {
    expect(withName({ ...OBJ, title: "Keep" }, "Other.json").entities[0].name).toBe("Keep");
    expect(withName({ ...OBJ, title: "Some Title", $id: "https://x/FromId.v1.json" }, "FromFile.json").entities[0].name).toBe("FromId");
  });

  it("ignores a file name that is no identifier", () => {
    expect(withName({ ...OBJ, title: "Some Title" }, "my schema (1).json").entities[0].name).toBe("Some Title");
  });
});
