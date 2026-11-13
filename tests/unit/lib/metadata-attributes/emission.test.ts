import { describe, it, expect } from "vitest";
import {
  addAvroProperties,
  itemsTagsFor,
  moveTagsToItems,
  skippedAttributeWarning,
  stripInternal,
  stripInternalFromClosure,
} from "@/lib/metadata-attributes/emission";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

const SECURITY: MetadataAttributeDefinition = {
  key: "x-securityClassification",
  label: "Security classification",
  description: "",
  valueSchema: { type: "object", properties: { data_category: { type: "string" }, data_class: { type: "string" } } },
  targets: ["field"],
  scope: "schema",
  placement: "abc-primitive",
  derive: { data_class: "{class}" },
  requiredWhen: "never",
};
const REVIEW: MetadataAttributeDefinition = {
  key: "x-review-note",
  label: "Review note",
  description: "",
  valueSchema: { type: "string" },
  targets: ["field", "entity"],
  scope: "internal",
  placement: "field",
  requiredWhen: "never",
};
const OWNER: MetadataAttributeDefinition = { ...REVIEW, key: "x-owner-team", label: "Owner", scope: "schema", targets: ["entity"] };

const field = (name: string, type: string, openapi?: Record<string, unknown>, complexType?: SuperSchemaField["complexType"]): SuperSchemaField =>
  ({
    name,
    type,
    nullable: false,
    isKey: false,
    description: "",
    aliases: [],
    sortOrder: 0,
    decorators: openapi ? { typespec: { extensions: { openapi } } } : {},
    ...(complexType ? { complexType } : {}),
  }) as SuperSchemaField;

const model = (fields: SuperSchemaField[], entityExtensions?: Record<string, unknown>): SuperSchemaModel =>
  ({
    entity: {
      id: "e1",
      name: "Customer",
      domain: "Sales",
      domainId: "d",
      description: "",
      status: "DRAFT",
      version: 1,
      metadata: entityExtensions ? { custom: { extensions: entityExtensions } } : {},
    },
    fields,
  }) as unknown as SuperSchemaModel;

const CLASS2 = { data_class: "class2", data_category: "ConsumerPersonal" };

describe("stripInternal", () => {
  it("removes an internal key and keeps a schema key, on fields and on the entity; never mutates the input", () => {
    const input = model(
      [field("note", "string", { "x-review-note": "check", "x-securityClassification": CLASS2 })],
      { "x-review-note": "entity note", "x-owner-team": "payments" }
    );
    const snapshot = structuredClone(input);
    const out = stripInternal(input, [SECURITY, REVIEW, OWNER]);
    expect(out.fields[0].decorators.typespec?.extensions?.openapi).toEqual({ "x-securityClassification": CLASS2 });
    expect(out.entity.metadata.custom).toEqual({ extensions: { "x-owner-team": "payments" } });
    expect(input).toEqual(snapshot);
  });

  it("returns the same model reference when there are no internal definitions, or nothing to strip", () => {
    const input = model([field("note", "string", { "x-review-note": "check" })]);
    expect(stripInternal(input, [SECURITY])).toBe(input);
    const clean = model([field("email", "string", { "x-securityClassification": CLASS2 })]);
    expect(stripInternal(clean, [SECURITY, REVIEW])).toBe(clean);
  });
});

describe("stripInternalFromClosure", () => {
  it("strips the raw field decorators and entity metadata of every member; same reference when nothing changes", () => {
    const entity = { id: "e1", name: "Customer", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: { custom: { extensions: { "x-review-note": "n" } } }, domain: null };
    const fields = [{ id: "f1", name: "note", type: "string", decorators: { typespec: { extensions: { openapi: { "x-review-note": "c", "x-a": 1 } } } } }];
    const member = { entityId: "e1", ref: { entityId: "e1", domain: "_", product: "_", entity: "Customer" }, source: "draft" as const, entity, fields };
    const closure = { root: member, entities: [member], draftEntities: [], cycles: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = stripInternalFromClosure(closure as any, [REVIEW]) as any;
    expect(out.entities[0].fields[0].decorators).toEqual({ typespec: { extensions: { openapi: { "x-a": 1 } } } });
    expect(out.entities[0].entity.metadata).toEqual({});
    expect(out.root).toBe(out.entities[0]);
    expect(fields[0].decorators.typespec.extensions.openapi).toEqual({ "x-review-note": "c", "x-a": 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(stripInternalFromClosure(closure as any, [SECURITY])).toBe(closure);
  });
});

describe("itemsTagsFor", () => {
  it("lists the abc-primitive keys of arrays of primitives and of nested arrays; not of scalars or reference arrays", () => {
    const m = model([
      field("email", "string", { "x-securityClassification": CLASS2 }),
      field("tags", "array", { "x-securityClassification": CLASS2 }, { arrayElementType: "string" }),
      field("matrix", "array", { "x-securityClassification": CLASS2 }, { arrayElementType: "array" }),
      field("addresses", "array", { "x-securityClassification": CLASS2 }, { arrayElementType: "reference", referencedEntityName: "Address" }),
      field("plain", "array", { "x-other": 1 }, { arrayElementType: "string" }),
    ]);
    expect(itemsTagsFor(m, [SECURITY, REVIEW])).toEqual({ tags: ["x-securityClassification"], matrix: ["x-securityClassification"] });
  });
});

const jsonFile = (schema: unknown) => ({ path: "Customer.json", content: JSON.stringify(schema, null, 4) + "\n" });

describe("moveTagsToItems", () => {
  it("moves the key from a string[] property to its items (JSON)", () => {
    const file = jsonFile({ type: "object", properties: { tags: { type: "array", items: { type: "string" }, "x-securityClassification": CLASS2 } } });
    const out = moveTagsToItems(file, { tags: ["x-securityClassification"] });
    const parsed = JSON.parse(out.content);
    expect(parsed.properties.tags).toEqual({ type: "array", items: { type: "string", "x-securityClassification": CLASS2 } });
    expect(out.content.endsWith("}\n")).toBe(true);
    expect(out.content).toContain('\n    "type": "object"');
  });

  it("moves it to the innermost non-array items for string[][]", () => {
    const file = jsonFile({ properties: { matrix: { type: "array", items: { type: "array", items: { type: "string" } }, "x-securityClassification": CLASS2 } } });
    const parsed = JSON.parse(moveTagsToItems(file, { matrix: ["x-securityClassification"] }).content);
    expect(parsed.properties.matrix).toEqual({ type: "array", items: { type: "array", items: { type: "string", "x-securityClassification": CLASS2 } } });
  });

  it("wraps a $ref items in allOf", () => {
    const file = jsonFile({ properties: { codes: { type: "array", items: { $ref: "Code.json" }, "x-securityClassification": CLASS2 } } });
    const parsed = JSON.parse(moveTagsToItems(file, { codes: ["x-securityClassification"] }).content);
    expect(parsed.properties.codes).toEqual({ type: "array", items: { allOf: [{ $ref: "Code.json" }], "x-securityClassification": CLASS2 } });
  });

  it("changes only that node of a YAML document", () => {
    const yaml = [
      "openapi: 3.1.0",
      "info:",
      "  title: Customer",
      "  version: 0.0.0",
      "components:",
      "  schemas:",
      "    Customer:",
      "      type: object",
      "      properties:",
      "        email:",
      "          type: string",
      "          x-securityClassification:",
      "            data_class: class2",
      "        tags:",
      "          type: array",
      "          items:",
      "            type: string",
      "          x-securityClassification:",
      "            data_class: class3",
      "",
    ].join("\n");
    const out = moveTagsToItems({ path: "openapi.yaml", content: yaml }, { tags: ["x-securityClassification"] });
    const expected = [
      "openapi: 3.1.0",
      "info:",
      "  title: Customer",
      "  version: 0.0.0",
      "components:",
      "  schemas:",
      "    Customer:",
      "      type: object",
      "      properties:",
      "        email:",
      "          type: string",
      "          x-securityClassification:",
      "            data_class: class2",
      "        tags:",
      "          type: array",
      "          items:",
      "            type: string",
      "            x-securityClassification:",
      "              data_class: class3",
      "",
    ].join("\n");
    expect(out.content).toBe(expected);
  });

  it("finds the one array branch of a nullable array (anyOf / oneOf, JSON and YAML)", () => {
    const file = jsonFile({ properties: { tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }], "x-securityClassification": CLASS2 } } });
    const parsed = JSON.parse(moveTagsToItems(file, { tags: ["x-securityClassification"] }).content);
    expect(parsed.properties.tags).toEqual({ anyOf: [{ type: "array", items: { type: "string", "x-securityClassification": CLASS2 } }, { type: "null" }] });

    const typeList = jsonFile({ properties: { tags: { type: ["array", "null"], items: { type: "string" }, "x-securityClassification": CLASS2 } } });
    expect(JSON.parse(moveTagsToItems(typeList, { tags: ["x-securityClassification"] }).content).properties.tags.items["x-securityClassification"]).toEqual(CLASS2);

    const yaml = [
      "components:",
      "  schemas:",
      "    Customer:",
      "      properties:",
      "        tags:",
      "          oneOf:",
      "            - type: array",
      "              items:",
      "                type: string",
      "            - type: \"null\"",
      "          x-securityClassification:",
      "            data_class: class3",
      "",
    ].join("\n");
    expect(moveTagsToItems({ path: "a.yaml", content: yaml }, { tags: ["x-securityClassification"] }).content).toBe(
      [
        "components:",
        "  schemas:",
        "    Customer:",
        "      properties:",
        "        tags:",
        "          oneOf:",
        "            - type: array",
        "              items:",
        "                type: string",
        "                x-securityClassification:",
        "                  data_class: class3",
        "            - type: \"null\"",
        "",
      ].join("\n")
    );
    // Two array branches: no way to tell which one is the field's, so nothing moves.
    const two = jsonFile({ properties: { tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "array", items: { type: "integer" } }], "x-securityClassification": CLASS2 } } });
    expect(moveTagsToItems(two, { tags: ["x-securityClassification"] }).content).toBe(two.content);
  });

  it("with schema names, looks only at the named $defs entries (a JSON Schema bundle)", () => {
    const tags = { type: "array", items: { type: "string" }, "x-securityClassification": CLASS2 };
    const file = jsonFile({ $id: "Order", $defs: { Order: { properties: { tags } }, Other: { properties: { tags } } } });
    const parsed = JSON.parse(moveTagsToItems(file, { tags: ["x-securityClassification"] }, ["Order"]).content);
    expect(parsed.$defs.Order.properties.tags.items["x-securityClassification"]).toEqual(CLASS2);
    expect(parsed.$defs.Other.properties.tags["x-securityClassification"]).toEqual(CLASS2);
  });

  it("returns the identical content string when nothing matched", () => {
    const file = jsonFile({ properties: { tags: { type: "array", items: { type: "string" } } } });
    expect(moveTagsToItems(file, { tags: ["x-securityClassification"] }).content).toBe(file.content);
    expect(moveTagsToItems(file, {}).content).toBe(file.content);
    const yaml = { path: "a.yaml", content: "components:\n  schemas:\n    A:\n      properties:\n        tags:\n          type: array\n" };
    expect(moveTagsToItems(yaml, { tags: ["x-securityClassification"] }).content).toBe(yaml.content);
    const other = { path: "a.proto", content: "message A {}" };
    expect(moveTagsToItems(other, { tags: ["x-securityClassification"] }).content).toBe(other.content);
  });
});

describe("addAvroProperties", () => {
  const avsc = JSON.stringify(
    { type: "record", name: "Customer", namespace: "sales", fields: [{ name: "email", type: "string" }, { name: "note", type: "string" }] },
    null,
    2
  );

  it("adds schema-scope values to the matching field and record objects", () => {
    const m = model([field("email", "string", { "x-securityClassification": CLASS2 })], { "x-owner-team": "payments" });
    const out = JSON.parse(addAvroProperties({ path: "Customer.avsc", content: avsc }, m, [SECURITY, OWNER]).content);
    expect(out["x-owner-team"]).toBe("payments");
    expect(out.fields[0]).toEqual({ name: "email", type: "string", "x-securityClassification": CLASS2 });
    expect(out.fields[1]).toEqual({ name: "note", type: "string" });
  });

  it("ignores undefined and internal keys; identical content when nothing matched", () => {
    const m = model([field("note", "string", { "x-review-note": "c", "x-free": 1 })]);
    const file = { path: "Customer.avsc", content: avsc };
    expect(addAvroProperties(file, m, [SECURITY, REVIEW]).content).toBe(avsc);
  });
});

describe("addAvroProperties: full-name matching", () => {
  const m = model([field("email", "string", { "x-securityClassification": CLASS2 })]);
  const nested = JSON.stringify(
    {
      type: "record", name: "Order", namespace: "a",
      fields: [
        { name: "buyer", type: { type: "record", name: "Customer", namespace: "b", fields: [{ name: "email", type: "string" }] } },
        { name: "seller", type: { type: "record", name: "Customer", fields: [{ name: "email", type: "string" }] } },
      ],
    },
    null,
    2
  );
  it("tags only the record with the given namespace and name; a namespace is inherited from the enclosing record", () => {
    const inB = JSON.parse(addAvroProperties({ path: "o.avsc", content: nested }, m, [SECURITY], { namespace: "b", name: "Customer" }).content);
    expect(inB.fields[0].type.fields[0]["x-securityClassification"]).toEqual(CLASS2);
    expect(inB.fields[1].type.fields[0]["x-securityClassification"]).toBeUndefined();
    const inA = JSON.parse(addAvroProperties({ path: "o.avsc", content: nested }, m, [SECURITY], { namespace: "a", name: "Customer" }).content);
    expect(inA.fields[0].type.fields[0]["x-securityClassification"]).toBeUndefined();
    expect(inA.fields[1].type.fields[0]["x-securityClassification"]).toEqual(CLASS2);
  });
  it("without a full name, only the file's top-level record named after the entity", () => {
    expect(addAvroProperties({ path: "o.avsc", content: nested }, m, [SECURITY]).content).toBe(nested);
  });
});

describe("skippedAttributeWarning", () => {
  it("names the target and the keys", () => {
    const w = skippedAttributeWarning("java-pojo", ["x-securityClassification", "x-owner-team"]);
    expect(w).toContain("Java POJO");
    expect(w).toContain("x-securityClassification, x-owner-team");
  });
});
