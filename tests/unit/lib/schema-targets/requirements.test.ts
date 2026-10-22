import { describe, expect, it } from "vitest";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { getTargetRequirements, primaryKeyIneligibility, type RequirementField } from "@/lib/schema-targets/requirements";

const f = (name: string, over: Partial<RequirementField> = {}): RequirementField => ({
  name, isKey: false, nullable: false, type: "string", ...over,
});
const NEEDS_KEY = ["bigquery", "postgresql", "spanner"];

describe("getTargetRequirements: primary key", () => {
  it.each(NEEDS_KEY)("%s with no key field asks for a primary key", (target) => {
    const { missing } = getTargetRequirements(target, { name: "Order", fields: [f("tenant"), f("note", { nullable: true })] });
    expect(missing).toHaveLength(1);
    expect(missing[0].code).toBe("primary-key");
    expect(missing[0].message).toContain("primary key");
    expect(missing[0].candidates).toEqual(["tenant", "note"]);
  });

  it.each(NEEDS_KEY)("%s with a key field asks for nothing", (target) => {
    expect(getTargetRequirements(target, { name: "Order", fields: [f("a", { isKey: true }), f("b")] })).toEqual({ missing: [] });
  });

  it("composite key already flagged -> none", () => {
    const fields = [f("a", { isKey: true }), f("b", { isKey: true }), f("c")];
    expect(getTargetRequirements("bigquery", { name: "T", fields }).missing).toEqual([]);
  });

  it("empty field list -> missing with no candidates", () => {
    const { missing } = getTargetRequirements("spanner", { name: "T", fields: [] });
    expect(missing).toHaveLength(1);
    expect(missing[0].candidates).toEqual([]);
    expect(missing[0].suggested).toEqual([]);
  });

  it.each([
    ["id", "Order", [f("name"), f("id", { type: "int64" })], ["id"]],
    ["<entity>_id", "Order", [f("name"), f("order_id")], ["order_id"]],
    ["<entity>Id", "Order", [f("name"), f("orderId")], ["orderId"]],
    ["uuid", "Order", [f("name"), f("uuid")], ["uuid"]],
    ["key", "Order", [f("name"), f("key")], ["key"]],
    ["exact id wins over uuid", "Order", [f("uuid"), f("id")], ["id"]],
    ["first required string", "Order", [f("note", { nullable: true }), f("tenant"), f("email")], ["tenant"]],
    ["required int", "Order", [f("amount", { type: "float64" }), f("seq", { type: "int32" })], ["seq"]],
    ["all nullable -> none", "Order", [f("a", { nullable: true }), f("b", { nullable: true })], []],
    ["required but not key-like type -> none", "Order", [f("amount", { type: "float64" }), f("at", { type: "utcDateTime" })], []],
  ] as const)("suggests (%s)", (_label, entity, fields, expected) => {
    const { missing } = getTargetRequirements("postgresql", { name: entity, fields: [...fields] });
    expect(missing[0].suggested).toEqual(expected);
  });

  it("never offers an array, map or object field as a key (no target can key on a collection)", () => {
    const fields = [f("tags", { type: "array" }), f("attrs", { type: "map" }), f("meta", { type: "object" }), f("owner", { type: "reference" }), f("tenant")];
    const { missing } = getTargetRequirements("bigquery", { name: "T", fields });
    expect(missing[0].candidates).toEqual(["owner", "tenant"]);
  });

  it("never offers json, union or an unresolved-reference field either, and gives the reason", () => {
    const fields = [f("j", { type: "json" }), f("u", { type: "union" }), f("d", { type: "reference", dangling: true }), f("tenant")];
    expect(getTargetRequirements("spanner", { name: "T", fields }).missing[0].candidates).toEqual(["tenant"]);
    expect(primaryKeyIneligibility({ name: "j", type: "json" })).toContain('"j"');
    expect(primaryKeyIneligibility({ name: "d", type: "reference", dangling: true })).toContain("unresolved reference");
    expect(primaryKeyIneligibility({ name: "tenant", type: "string" })).toBeNull();
  });

  it("never marks a suggestion as a key (inputs are not mutated)", () => {
    const fields = [f("id")];
    getTargetRequirements("bigquery", { name: "T", fields });
    expect(fields[0].isKey).toBe(false);
  });
});

describe("getTargetRequirements: targets without requirements", () => {
  it.each(["avro", "openapi3", "json-schema", "protobuf", "java-pojo", "http-client-js", "nope", "__proto__", "constructor"])(
    "%s -> none",
    (target) => {
      expect(getTargetRequirements(target, { name: "Order", fields: [f("a")] })).toEqual({ missing: [] });
    },
  );

  it("knows every catalog target (the key targets exist in the catalog)", () => {
    const keys = getSchemaTargetCatalog().map((t) => t.key);
    for (const id of NEEDS_KEY) expect(keys).toContain(id);
  });
});
