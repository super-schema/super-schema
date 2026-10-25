import { describe, expect, it } from "vitest";
import { numberedName } from "@/lib/entity-name";
import { followEntityRenames, renameBuiltInEntities, renameBuiltInPayload } from "@/lib/builtin-entity-renames";
import { builtInRenamedMessage, isReservedRenameNote } from "@/lib/reserved-field-names";

// FINAL FIX WAVE 4, I1: an import never skips an entity because its name is a built-in type name (`Date`, `Duration`, `Record`, `Map`, `List`,
// `Set`, `Object`, `Instant` ...) and never leaves a reference to it dangling: it renames the entity by the rule the events import uses
// (`Duration` -> `Duration2`), follows every reference, and says so. Direct creation and rename in the UI keep refusing (entity-name.ts).

interface TestField {
  name: string;
  type: string;
  decorators?: Record<string, unknown>;
}
const field = (name: string, extra: { type?: string; decorators?: Record<string, unknown> } = {}): TestField => ({ name, type: "string", ...extra });
const entity = (name: string, fields: TestField[] = [], extra: { extends?: string } = {}) => ({ name, fields, ...extra });

describe("numberedName: the one suffix rule (the events import's: Name, Name2, Name3)", () => {
  it("is the name itself for the first attempt and the name plus the number after", () => {
    expect(numberedName("Duration", 1)).toBe("Duration");
    expect(numberedName("Duration", 2)).toBe("Duration2");
    expect(numberedName("Duration", 12)).toBe("Duration12");
  });

  it("keeps the result within 128 characters by cutting the name, not the number", () => {
    const long = "a".repeat(128);
    expect(numberedName(long, 2)).toBe(`${"a".repeat(127)}2`);
    expect(numberedName(long, 2)).toHaveLength(128);
  });
});

describe("renameBuiltInEntities", () => {
  it("renames every built-in name of the batch, and nothing else", () => {
    const names = ["Date", "Duration", "Record", "Map", "List", "Set", "Object", "Instant"];
    const out = renameBuiltInEntities([...names.map((n) => entity(n)), entity("Order"), entity("Customer")]);
    expect(out.items.map((i) => i.name)).toEqual([...names.map((n) => `${n}2`), "Order", "Customer"]);
    expect([...out.renames]).toEqual(names.map((n) => [n, `${n}2`]));
  });

  it("returns the very same array, and no renames, when no name is a built-in", () => {
    const list = [entity("Order"), entity("Urls"), entity("model")];
    const out = renameBuiltInEntities(list, { onRename: () => { throw new Error("no rename expected"); } });
    expect(out.items).toBe(list);
    expect(out.renames.size).toBe(0);
  });

  it("matches case-insensitively, like the refusal does (Url, URL and url are one)", () => {
    const out = renameBuiltInEntities([entity("URL"), entity("string")]);
    expect(out.items.map((i) => i.name)).toEqual(["URL2", "string2"]);
  });

  it("goes on to the next number when the first is taken in the batch or among the names it is told about", () => {
    expect(renameBuiltInEntities([entity("Duration"), entity("Duration2")]).items.map((i) => i.name)).toEqual(["Duration3", "Duration2"]);
    expect(renameBuiltInEntities([entity("Duration")], { taken: ["duration2", "DURATION3"] }).items[0]!.name).toBe("Duration4");
    // a number that is a name of its own in the batch, later in the list
    expect(renameBuiltInEntities([entity("Duration"), entity("Order"), entity("DURATION2")]).items.map((i) => i.name)).toEqual(["Duration3", "Order", "DURATION2"]);
  });

  it("does not take a number whose URL slug a name of the batch already has", () => {
    // `Duration2!` is another name than `Duration2`, with the same URL slug (`duration2`)
    expect(renameBuiltInEntities([entity("Duration"), entity("Duration2!")]).items.map((i) => i.name)).toEqual(["Duration3", "Duration2!"]);
    expect(renameBuiltInEntities([entity("Duration")], { takenSlugs: ["duration2"] }).items[0]!.name).toBe("Duration3");
  });

  it("is deterministic: the same batch always gets the same names", () => {
    const batch = () => [entity("Record"), entity("Map"), entity("Order", [field("r", { decorators: { referencedEntityName: "Record" } })])];
    expect(JSON.stringify(renameBuiltInEntities(batch()))).toBe(JSON.stringify(renameBuiltInEntities(batch())));
  });

  it("gives two entities that carry the SAME built-in name one new name, reported once", () => {
    const heard: string[] = [];
    const out = renameBuiltInEntities([entity("Duration"), entity("Duration")], { onRename: (from, to) => heard.push(`${from}>${to}`) });
    expect(out.items.map((i) => i.name)).toEqual(["Duration2", "Duration2"]);
    expect(heard).toEqual(["Duration>Duration2"]);
  });

  it("tells onRename which languages the name is built in (for the note)", () => {
    const heard: Array<[string, string, string[]]> = [];
    renameBuiltInEntities([entity("Duration"), entity("url")], { onRename: (from, to, languages) => heard.push([from, to, languages]) });
    expect(heard).toEqual([
      ["Duration", "Duration2", ["TypeSpec", "Java"]],
      ["url", "url2", ["TypeSpec"]],
    ]);
  });

  it("makes an `extends` that points at a renamed entity follow it", () => {
    const out = renameBuiltInEntities([entity("Record"), entity("Child", [], { extends: "Record" })]);
    expect(out.items.map((i) => [i.name, i.extends])).toEqual([["Record2", undefined], ["Child", "Record2"]]);
  });

  it("makes every reference follow: a reference field, an array of it, the members of a union (also the entity's own fields)", () => {
    const out = renameBuiltInEntities([
      entity("Duration", [field("self", { decorators: { referencedEntityName: "Duration" } })]),
      entity("Order", [
        field("timeout", { type: "reference", decorators: { referencedEntityName: "Duration" } }),
        field("timeouts", { type: "array", decorators: { referencedEntityName: "Duration", arrayElementType: "reference" } }),
        field("choice", { type: "union", decorators: { unionName: "Choice", unionMembers: ["Duration", "Order", "string"] } }),
        field("other", { type: "reference", decorators: { referencedEntityName: "Customer" } }),
      ]),
    ]);
    const [duration, order] = out.items;
    expect(duration!.fields[0]!.decorators).toEqual({ referencedEntityName: "Duration2" });
    const decorators = order!.fields.map((f) => f.decorators);
    expect(decorators[0]).toEqual({ referencedEntityName: "Duration2" });
    expect(decorators[1]).toEqual({ referencedEntityName: "Duration2", arrayElementType: "reference" });
    expect(decorators[2]).toEqual({ unionName: "Choice", unionMembers: ["Duration2", "Order", "string"] });
    expect(decorators[3]).toEqual({ referencedEntityName: "Customer" });
  });

  it("does not touch the logical type of a field (an entity named like one cannot turn every string into a reference)", () => {
    const out = renameBuiltInEntities([entity("string"), entity("Order", [field("a", { type: "string" })])]);
    expect(out.items[1]!.fields[0]!.type).toBe("string");
  });

  it("rewrites the TYPE TEXT of a field only for the formats whose field type is a name (TypeSpec, OpenAPI): the bare name, an array of it, a union of names", () => {
    const fields = [field("a", { type: "Duration" }), field("b", { type: "Duration[]" }), field("c", { type: "Duration | null" }), field("d", { type: "Durations" }), field("e", { type: "string" })];
    const batch = () => [entity("Duration"), entity("Order", fields)];
    expect(renameBuiltInEntities(batch(), { typeText: true }).items[1]!.fields.map((f) => f.type)).toEqual(["Duration2", "Duration2[]", "Duration2 | null", "Durations", "string"]);
    expect(renameBuiltInEntities(batch()).items[1]!.fields.map((f) => f.type)).toEqual(["Duration", "Duration[]", "Duration | null", "Durations", "string"]);
  });

  it("trims the names it compares (a padded name is the same name)", () => {
    const out = renameBuiltInEntities([entity(" Duration "), entity("Order", [field("t", { decorators: { referencedEntityName: "Duration" } })])]);
    expect(out.items[0]!.name).toBe("Duration2");
    expect(out.items[1]!.fields[0]!.decorators).toEqual({ referencedEntityName: "Duration2" });
  });
});

describe("followEntityRenames", () => {
  it("is the same field when nothing it says is renamed, and a copy that follows otherwise", () => {
    const f = field("t", { decorators: { referencedEntityName: "Customer" } });
    expect(followEntityRenames(f, new Map([["Duration", "Duration2"]]), false)).toBe(f);
    const g = field("t", { decorators: { referencedEntityName: "Duration" } });
    expect(followEntityRenames(g, new Map([["Duration", "Duration2"]]), false)).toEqual({ name: "t", type: "string", decorators: { referencedEntityName: "Duration2" } });
    expect(g.decorators).toEqual({ referencedEntityName: "Duration" });
  });
});

describe("the note", () => {
  it("says what was renamed and why, and is recognised as a note, never as an error that stopped the import", () => {
    const note = builtInRenamedMessage("Duration", "Duration2", ["TypeSpec", "Java"]);
    expect(note).toBe('The entity "Duration" was renamed to "Duration2" because "Duration" is a built-in type name in TypeSpec/Java; every reference to it now says "Duration2".');
    expect(isReservedRenameNote(note)).toBe(true);
    expect(isReservedRenameNote('The entity "x" was renamed to "y" because something else')).toBe(false);
  });
});

describe("renameBuiltInPayload: what else in a bulk import names an entity", () => {
  const payload = () => ({
    sourceFormat: "typespec",
    entities: [
      entity("Duration", [field("n", { type: "int32" })]),
      entity("Order", [field("timeout", { type: "Duration" }), field("hist", { type: "Duration[]" })]),
    ],
    unionTypes: [{ name: "Span", memberTypes: ["Duration", "string"] }],
    services: [
      {
        name: "DurationApi",
        scope: "entity" as const,
        entityName: "Duration",
        operations: [{ name: "read", returnType: "Duration", params: [{ name: "body", type: "Duration[]", isOptional: false }, { name: "q", type: "string", isOptional: true }] }],
      },
    ],
  });

  it("renames the entity and rewrites its union members, the entity of a service and the types of its operations", () => {
    const heard: string[] = [];
    const out = renameBuiltInPayload(payload(), { onRename: (from, to) => heard.push(`${from}>${to}`) });
    expect(heard).toEqual(["Duration>Duration2"]);
    expect(out.entities.map((e) => e.name)).toEqual(["Duration2", "Order"]);
    expect(out.entities[1]!.fields.map((f) => f.type)).toEqual(["Duration2", "Duration2[]"]);
    expect(out.unionTypes).toEqual([{ name: "Span", memberTypes: ["Duration2", "string"] }]);
    expect(out.services[0]).toMatchObject({ entityName: "Duration2", operations: [{ returnType: "Duration2", params: [{ type: "Duration2[]" }, { type: "string" }] }] });
  });

  it("leaves a payload with no built-in name exactly as it is", () => {
    const clean = { sourceFormat: "json-schema", entities: [entity("Order")], unionTypes: [], services: [] };
    const out = renameBuiltInPayload(clean, {});
    expect(out.entities).toBe(clean.entities);
    expect(out.unionTypes).toBe(clean.unionTypes);
    expect(out.services).toBe(clean.services);
  });

  it("does not rewrite field TYPE text for a JSON Schema import (its field type is a logical type)", () => {
    const out = renameBuiltInPayload({ ...payload(), sourceFormat: "json-schema" }, {});
    expect(out.entities[1]!.fields.map((f) => f.type)).toEqual(["Duration", "Duration[]"]);
  });
});
