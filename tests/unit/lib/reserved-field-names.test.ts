import { describe, expect, it } from "vitest";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";
import {
  firstReservedFieldNameMessage,
  renameReservedFields,
  reservedFieldNameMessage,
  reservedFieldRenamedMessage,
} from "@/lib/reserved-field-names";

const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';

describe("reservedFieldNameMessage", () => {
  it("is null for an ordinary name", () => {
    for (const name of ["id", "email", "hasownproperty", "HasOwnProperty", "hasOwnProperty2", "hasOwnProperty_1", "valueOf", "toString", "constructor", ""]) {
      expect(reservedFieldNameMessage(name), name).toBeNull();
    }
  });

  it("names the field and what to do, for exactly the parser-unsafe names", () => {
    expect(reservedFieldNameMessage("hasOwnProperty")).toBe(MESSAGE);
    for (const name of PARSER_UNSAFE_KEYS) expect(reservedFieldNameMessage(name)).toBe(`"${name}" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.`);
  });

  it("compares the trimmed name, case-sensitively", () => {
    expect(reservedFieldNameMessage("  hasOwnProperty  ")).toBe(MESSAGE);
    expect(reservedFieldNameMessage("\thasOwnProperty\n")).toBe(MESSAGE);
    expect(reservedFieldNameMessage(" hasownproperty ")).toBeNull();
  });
});

describe("firstReservedFieldNameMessage", () => {
  it("is the message of the first field with a reserved name, or null", () => {
    expect(firstReservedFieldNameMessage([{ name: "id" }, { name: " hasOwnProperty" }, { name: "__proto__" }])).toBe(MESSAGE);
    expect(firstReservedFieldNameMessage([{ name: "id" }, { name: "hasownproperty" }])).toBeNull();
    expect(firstReservedFieldNameMessage([])).toBeNull();
  });
});

describe("renameReservedFields", () => {
  const rename = (names: string[]) => {
    const notes: Array<[string, string]> = [];
    const fields = renameReservedFields(names.map((name) => ({ name, type: "string" })), (from, to) => notes.push([from, to]));
    return { names: fields.map((f) => f.name), notes };
  };

  it("leaves every ordinary field (and the list itself) alone", () => {
    const list = [{ name: "id" }, { name: "hasownproperty" }];
    expect(renameReservedFields(list, () => { throw new Error("no rename expected"); })).toBe(list);
  });

  it("appends _1, _2 ... until the name is not reserved and not taken, and says so", () => {
    expect(rename(["hasOwnProperty"])).toEqual({ names: ["hasOwnProperty_1"], notes: [["hasOwnProperty", "hasOwnProperty_1"]] });
    expect(rename(["hasOwnProperty", "hasOwnProperty_1"]).names).toEqual(["hasOwnProperty_2", "hasOwnProperty_1"]);
    expect(rename(["hasOwnProperty_1", "hasOwnProperty"]).names).toEqual(["hasOwnProperty_1", "hasOwnProperty_2"]);
  });

  it("a name taken only by its URL slug (HASOWNPROPERTY_1 slugs like hasOwnProperty_1) is taken too", () => {
    expect(rename(["HASOWNPROPERTY_1", "hasOwnProperty"]).names).toEqual(["HASOWNPROPERTY_1", "hasOwnProperty_2"]);
  });

  it("trims a padded name before it is renamed", () => {
    expect(rename(["  hasOwnProperty "]).names).toEqual(["hasOwnProperty_1"]);
  });

  it("keeps the other properties of the field", () => {
    const [field] = renameReservedFields([{ name: "hasOwnProperty", type: "int32", nullable: true }], () => undefined);
    expect(field).toEqual({ name: "hasOwnProperty_1", type: "int32", nullable: true });
  });
});

describe("reservedFieldRenamedMessage", () => {
  it("says what was renamed and why, and where", () => {
    expect(reservedFieldRenamedMessage("hasOwnProperty", "hasOwnProperty_1", "Order")).toBe(
      'The field "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved. It belongs to the entity "Order".',
    );
  });
});
