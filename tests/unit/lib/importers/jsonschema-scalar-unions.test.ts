/**
 * A property that can be one of several scalar types (`type: ["string", "integer"]`, `oneOf: [{ type: "string" }, { type: "integer" }]`)
 * imports as a union of those types, not as its first member: the other types were dropped without a word before.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const field = (doc: ReturnType<typeof importDoc>, name: string, entity = "R") => doc.entities.find((e) => e.name === entity)!.fields.find((f) => f.name === name)!;
const doc = (properties: unknown, extra: Record<string, unknown> = {}) => importDoc({ title: "R", type: "object", required: ["v"], properties, ...extra });

describe("type: [a, b] with several non-null types", () => {
  it("imports as a union of the member types, with a union declared for it", () => {
    const d = doc({ v: { type: ["string", "integer"] } });
    expect(field(d, "v")).toMatchObject({ type: "union", unionMembers: ["string", "integer"], confidence: "medium", nullable: false });
    const name = field(d, "v").unionName!;
    expect(name).toBe("R_v_Union");
    expect(d.unions).toEqual([{ name, memberTypes: ["string", "integer"] }]);
  });

  it("null in the list makes it nullable, and is not a member", () => {
    const d = doc({ v: { type: ["string", "integer", "null"] } });
    expect(field(d, "v")).toMatchObject({ type: "union", unionMembers: ["string", "integer"] });
    expect(field(d, "v").nullable).toBe(true);
  });

  it("a format applies to the members it knows", () => {
    const d = doc({ v: { type: ["string", "integer"], format: "date-time" } });
    expect(field(d, "v").unionMembers).toEqual(["utcDateTime", "integer"]);
  });

  it("number is float64, boolean boolean", () => {
    expect(field(doc({ v: { type: ["number", "boolean"] } }), "v").unionMembers).toEqual(["float64", "boolean"]);
  });

  it("the items of an array may be one too", () => {
    const d = doc({ v: { type: "array", items: { type: ["string", "integer"] } } });
    expect(field(d, "v")).toMatchObject({ type: "array", arrayElementType: "union", unionMembers: ["string", "integer"] });
  });

  it("a type no scalar union can hold (object, array) keeps the first type at LOW confidence and names what was dropped", () => {
    const d = doc({ v: { type: ["string", "array"] } });
    expect(field(d, "v")).toMatchObject({ type: "string", confidence: "low" });
    expect(d.warnings).toContain("Property R.v is typed [string, array]: only string was imported (dropped: array); a union cannot hold array");
  });

  it("a single type next to null is still just that type, high confidence", () => {
    const d = doc({ v: { type: ["string", "null"] } });
    expect(field(d, "v")).toMatchObject({ type: "string", confidence: "high" });
    expect(d.unions ?? []).toEqual([]);
  });
});

describe("oneOf / anyOf of scalar members", () => {
  it("oneOf [string, integer] is a union", () => {
    const d = doc({ v: { oneOf: [{ type: "string" }, { type: "integer" }] } });
    expect(field(d, "v")).toMatchObject({ type: "union", unionMembers: ["string", "integer"], unionName: "R_v_Union", confidence: "medium" });
  });

  it("anyOf with formats names the logical types, null makes it nullable", () => {
    const d = doc({ v: { anyOf: [{ type: "string", format: "date" }, { type: "string" }, { type: "null" }] } });
    expect(field(d, "v")).toMatchObject({ type: "union", unionMembers: ["plainDate", "string"], nullable: true });
  });

  it("a ref next to a scalar keeps the first-member fallback (a union naming an entity is not generated for most targets: KD-029)", () => {
    const d = doc(
      { v: { oneOf: [{ $ref: "#/$defs/Card" }, { type: "string" }] } },
      { $defs: { Card: { type: "object", properties: { pan: { type: "string" } } } } }
    );
    expect(field(d, "v")).toMatchObject({ type: "reference", confidence: "low" });
    expect(d.unions ?? []).toEqual([]);
  });

  it("members that name the same type are one member: a single type is no union (first member, as before)", () => {
    const d = doc({ v: { oneOf: [{ type: "string", minLength: 1 }, { type: "string", maxLength: 2 }] } });
    expect(field(d, "v")).toMatchObject({ type: "string", confidence: "low" });
    // what the second member says is still kept (item-level extensions)
    expect(field(d, "v").extensions).toMatchObject({ "x-oneOf-1-maxLength": 2 });
  });

  it("an inline object (or enum, array) member keeps the first-member fallback", () => {
    const d = doc({ v: { oneOf: [{ type: "string" }, { type: "object", properties: { k: { type: "string" } } }] } });
    expect(field(d, "v")).toMatchObject({ type: "string", confidence: "low" });
  });

  it("the array of a oneOf of scalars is an array of a union", () => {
    const d = doc({ v: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] } } });
    expect(field(d, "v")).toMatchObject({ type: "array", arrayElementType: "union", unionMembers: ["string", "integer"] });
  });
});

describe("a shared $defs union of scalars", () => {
  it("is a shared union, and the field that $refs it carries its members", () => {
    const d = importDoc({
      title: "R", type: "object", required: ["v"],
      properties: { v: { $ref: "#/$defs/Id" } },
      $defs: { Id: { description: "an id", oneOf: [{ type: "string" }, { type: "integer" }] } },
    });
    expect(d.unions).toContainEqual({ name: "Id", memberTypes: ["string", "integer"], description: "an id" });
    expect(field(d, "v")).toMatchObject({ type: "union", unionName: "Id", unionMembers: ["string", "integer"] });
  });
});
