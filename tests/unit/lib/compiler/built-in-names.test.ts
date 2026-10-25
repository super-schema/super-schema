import { describe, it, expect } from "vitest";
import { builtInNameConflict, builtInNameMessage } from "@/lib/compiler/built-in-names";
import { entityNameMessage } from "@/lib/entity-name";

// FINAL WAVE 2b, G6: ONE function says whether a name is a built-in type name of a language the schemas are generated for.
describe("builtInNameConflict", () => {
  it.each([
    ["url", ["TypeSpec"]],
    ["int32", ["TypeSpec", "Protobuf"]],
    ["duration", ["TypeSpec"]],
    ["Record", ["TypeSpec", "Avro"]],
    ["Array", ["TypeSpec"]],
    ["Model", ["TypeSpec"]],
    ["string", ["TypeSpec", "Protobuf", "Avro"]],
    ["bool", ["Protobuf"]],
    ["bytes", ["TypeSpec", "Protobuf", "Avro"]],
    ["double", ["Protobuf", "Avro"]],
    ["null", ["TypeSpec", "Avro"]],
    ["enum", ["Avro"]],
    ["fixed", ["Avro"]],
    ["String", ["TypeSpec", "Java", "Protobuf", "Avro"]],
    ["Object", ["Java"]],
    ["Integer", ["Java"]],
    ["Long", ["Java", "Avro"]],
    ["List", ["Java"]],
    ["Map", ["Java", "Protobuf", "Avro"]],
    ["Set", ["Java"]],
    ["Date", ["Java"]],
    ["Instant", ["Java"]],
  ])("%s is a built-in name (%j)", (name, languages) => {
    const conflict = builtInNameConflict(name);
    expect(conflict).not.toBeNull();
    expect(conflict?.languages).toEqual(expect.arrayContaining(languages));
  });

  it("compares case-insensitively on the sanitized identifier: Url, URL, STRING, Int32 and `my url` handling", () => {
    for (const name of ["Url", "URL", "STRING", "Int32", "DURATION", "record", " url "]) expect(builtInNameConflict(name), name).not.toBeNull();
    // "my url" sanitizes to my_url: not a built-in; neither is a name that merely contains one
    for (const name of ["my url", "Urls", "Stringer", "Order", "Customer", "Address", "Event", "Item", "OrderItem", "Order_Item", "Int32Value", ""]) {
      expect(builtInNameConflict(name), name).toBeNull();
    }
  });

  it("names the name and the languages, and says to choose another", () => {
    expect(builtInNameMessage("url")).toBe('"url" is a built-in type name in TypeSpec; choose another name.');
    expect(builtInNameMessage("String")).toBe('"String" is a built-in type name in TypeSpec/Java/Protobuf/Avro; choose another name.');
    expect(builtInNameMessage("Customer")).toBeNull();
  });
});

describe("entityNameMessage (what an entity name is refused for: a reserved URL segment, or a built-in type name)", () => {
  it("is the reserved-segment message for 'Events', the built-in message for 'url', and null for a normal name", () => {
    expect(entityNameMessage("Events")).toContain("reserved");
    expect(entityNameMessage("url")).toBe('"url" is a built-in type name in TypeSpec; choose another name.');
    expect(entityNameMessage("Customer")).toBeNull();
  });
});
