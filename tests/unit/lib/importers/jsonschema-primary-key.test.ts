/**
 * A required property named `id` is the key of an imported entity only when its type can identify a row (the shared eligibility rule:
 * not an array / map / object / json / union / unresolved reference), and the requirement check counts a key only when it is eligible: an `id`
 * typed as an array or a dangling reference no longer skips the primary-key prompt of the DDL targets.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { getTargetRequirements, type RequirementField } from "@/lib/schema-targets/requirements";

function importDoc(properties: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify({ title: "R", type: "object", required: ["id"], properties }));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const idOf = (properties: unknown) => importDoc(properties).entities[0].fields.find((f) => f.name === "id")!;

describe("the importer marks `id` as the key only when it can be one", () => {
  it.each([
    ["a string", { id: { type: "string" } }],
    ["an integer", { id: { type: "integer", format: "int64" } }],
    ["a uuid", { id: { type: "string", format: "uuid" } }],
    ["an enum", { id: { type: "string", enum: ["A", "B"] } }],
  ])("%s: the key", (_label, properties) => {
    expect(idOf(properties).isKey).toBe(true);
  });

  it.each([
    ["an array", { id: { type: "array", items: { type: "string" } } }],
    ["an array of references", { id: { type: "array", items: { $ref: "ids.json" } } }],
    ["an object", { id: { type: "object", properties: { a: { type: "string" } } } }],
    ["a union", { id: { oneOf: [{ type: "string" }, { type: "integer" }] } }],
    ["an unresolved reference", { id: { $ref: "common/id.json" } }],
  ])("%s: not the key", (_label, properties) => {
    expect(idOf(properties).isKey).toBe(false);
  });

  it("an optional `id` and a differently named field are not keys, as before", () => {
    const d = parseJsonSchemaDocument(JSON.stringify({ title: "R", type: "object", properties: { id: { type: "string" }, other: { type: "string" } } }));
    if (!d.success) throw new Error("import failed");
    expect(d.data.entities[0].fields.map((f) => f.isKey)).toEqual([false, false]);
  });
});

describe("the primary-key check counts only a key that can be one", () => {
  const field = (over: Partial<RequirementField>): RequirementField => ({ name: "id", isKey: true, nullable: false, type: "string", ...over });
  const missing = (fields: RequirementField[]) => getTargetRequirements("postgresql", { name: "Evt", fields }).missing;

  it("a string key satisfies it", () => {
    expect(missing([field({})])).toEqual([]);
  });

  it.each([
    ["an array", { type: "array" }],
    ["a map", { type: "map" }],
    ["an object", { type: "object" }],
    ["json", { type: "json" }],
    ["a union", { type: "union" }],
    ["a dangling reference", { type: "reference", dangling: true }],
  ])("a key typed as %s still prompts, and is not a candidate", (_label, over) => {
    const asked = missing([field(over), field({ name: "code", isKey: false })]);
    expect(asked).toHaveLength(1);
    expect(asked[0].code).toBe("primary-key");
    expect(asked[0].candidates).toEqual(["code"]);
  });

  it("a resolved reference can be a key", () => {
    expect(missing([field({ type: "reference" })])).toEqual([]);
  });
});
