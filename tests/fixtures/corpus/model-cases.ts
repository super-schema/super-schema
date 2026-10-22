/**
 * Hand-built entity cases: PrismaEntityInput / PrismaFieldInput rows given directly (the shape the database holds), including every
 * logical type of src/lib/data-types.ts.
 */
import { DATA_TYPE_HIERARCHY } from "@/lib/data-types";
import type { CorpusCase, CorpusExpectations, ModelInput } from "./types";

type F = ModelInput["fields"][number];

function model(id: string, title: string, entityName: string, fields: F[], tags: string[], expectations: CorpusExpectations = {}, entity: Partial<ModelInput["entity"]> = {}): CorpusCase {
  return { id: `model-${id}`, title, kind: "model", source: { entity: { name: entityName, ...entity }, fields }, tags: ["model", ...tags], expectations: { roundTrip: false, ...expectations } };
}

const key = (name = "id", type = "string"): F => ({ name, type, isKey: true, nullable: false });
const decoratorsFor = (typeId: string): Record<string, unknown> => {
  switch (typeId) {
    case "array": return { arrayElementType: "string" };
    case "map": return { mapKeyType: "string", mapValueType: "int32" };
    case "object": return { nestedFields: [{ name: "inner", type: "string", nullable: false }, { name: "n", type: "int32", nullable: true }] };
    case "reference": return { referencedEntityName: "RelatedEntity" };
    default: return {};
  }
};
const familyFields = (category: string): F[] =>
  DATA_TYPE_HIERARCHY.filter((t) => t.category === category).map((t, i) => ({
    name: `f_${t.id}`, type: t.id, nullable: i % 2 === 0, isKey: false,
    precision: t.id === "decimal" || t.id === "decimal128" ? 38 : null, scale: t.id === "decimal" || t.id === "decimal128" ? 9 : null,
    description: `A ${t.id}`, aliases: t.id === "enum" ? ["ALPHA", "BETA"] : [], decorators: decoratorsFor(t.id),
  }));

export const MODEL_CASES: CorpusCase[] = [
  model("family-number", "every Number type", "NumberFamily", [key(), ...familyFields("Number")], ["types", "number"]),
  model("family-string", "every String type", "StringFamily", [key(), ...familyFields("String")], ["types", "string"]),
  model("family-boolean-bytes", "Boolean and Bytes types", "BoolBytes", [key(), ...familyFields("Boolean"), ...familyFields("Bytes")], ["types"]),
  model("family-datetime", "every Date & Time type", "DateTimeFamily", [key(), ...familyFields("Date & Time")], ["types", "datetime"]),
  model("family-structured", "every Structured type (enum/array/map/object)", "StructuredFamily", [key(), ...familyFields("Structured")], ["types", "structured"]),
  model("family-special", "Special type (reference)", "SpecialFamily", [key(), ...familyFields("Special")], ["types", "reference"]),
  model("all-44-types", "one field of every logical type", "AllTypes", [key(), ...DATA_TYPE_HIERARCHY.flatMap((t) => familyFields(t.category).filter((f) => f.name === `f_${t.id}`))], ["types", "wide"]),
  model("odd-names", "odd entity and field names", "weird entity-name.v2", [key("ID"), { name: "first-name", type: "string", nullable: true }, { name: "Last Name", type: "string", nullable: true }, { name: "a.b", type: "int32", nullable: true }, { name: "ünï", type: "string", nullable: true }, { name: "1st", type: "string", nullable: true }, { name: "x".repeat(200), type: "string", nullable: true }], ["names"]),
  model("reserved-names", "reserved-word field names", "ReservedModel", [key(), ...["model", "enum", "namespace", "order", "when", "select", "table", "class", "group", "user", "end"].map((name): F => ({ name, type: "string", nullable: true }))], ["names", "reserved-words"]),
  model("reserved-entity-name", "reserved-word entity name", "Order", [key(), { name: "when", type: "utcDateTime", nullable: true }], ["names", "reserved-words"]),
  model("no-key", "no key flagged (DB targets must ask)", "Keyless", [{ name: "a", type: "string", nullable: false }, { name: "b", type: "int32", nullable: true }], ["key"], { requiresPrimaryKey: true }),
  model("composite-key", "composite key", "CompositeKey", [key("tenantId"), key("itemId", "int64"), { name: "qty", type: "int32", nullable: false }], ["key"]),
  model("classification", "classified fields with governance decorators", "Classified", [key(), { name: "email", type: "string", nullable: false, classification: "PII", decorators: { classification: { level: "PII" } } }, { name: "ssn", type: "string", nullable: true, classification: "class4", decorators: { classification: { level: "class4" }, governance: { dataClass: "class4", dataCategory: "Intrinsic" } } }], ["classification"]),
  model("decorators-validation", "validation decorators and extensions", "Validated", [key(), { name: "name", type: "string", nullable: false, decorators: { typespec: { validation: { minLength: 1, maxLength: 80, pattern: "^[a-z]+$" } } } }, { name: "n", type: "int32", nullable: true, decorators: { typespec: { validation: { minValue: 0, maxValue: 9 } } } }, { name: "x", type: "string", nullable: true, decorators: { typespec: { extensions: { openapi: { "x-a": { b: [1, 2] }, "x-model": "reserved" } } } } }], ["decorators", "extension"]),
  model("aliases-enum", "enum field whose symbols travel as aliases", "AliasEnum", [key(), { name: "state", type: "enum", nullable: false, aliases: ["NEW", "in-progress", "1st", "class", ""] }, { name: "plain", type: "string", nullable: true, aliases: ["alt1", "alt2"] }], ["enum", "aliases"]),
  model("dangling-reference", "an unresolved external reference field", "DanglingModel", [key(), { name: "ext", type: "reference", nullable: false, decorators: { referencedEntityName: "date_time", danglingRef: { ref: "common/date_time.json" } } }, { name: "items", type: "array", nullable: true, decorators: { arrayElementType: "reference", referencedEntityName: "link", danglingRef: { ref: "link.json", element: true } } }], ["dangling"]),
  model("precision-scale", "decimals with precision and scale", "Decimals", [key(), { name: "money", type: "decimal", precision: 19, scale: 4, nullable: false }, { name: "tiny", type: "decimal", precision: 1, scale: 0, nullable: true }, { name: "big", type: "decimal128", precision: 38, scale: 18, nullable: true }, { name: "noprec", type: "decimal", nullable: true }], ["decimal"]),
  model("empty-entity", "entity with no fields", "NoFields", [], ["empty"], { requiresPrimaryKey: true }),
  model("hostile-descriptions", "descriptions with comment hazards", "HostileDesc", [key("id"), { name: "a", type: "string", nullable: true, description: "ends */ with \"quotes\" and ${x} and `tick` \\ and\nnewline -- sql; DROP" }], ["doc", "hostile"], {}, { description: "entity */ doc \"q\" \n multi" }),
  model("nested-arrays-of-objects", "array of nested objects / map of arrays", "NestedDeep", [key(), { name: "items", type: "array", nullable: true, decorators: { arrayElementType: "object", nestedFields: [{ name: "sku", type: "string", nullable: false }] } }, { name: "buckets", type: "map", nullable: true, decorators: { mapKeyType: "string", mapValueType: "array" } }], ["structured", "nested"]),
];
