import { describe, expect, it } from "vitest";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";
import {
  firstReservedFieldNameMessage,
  renameReservedFields,
  renameReservedNames,
  reservedFieldNameMessage,
  reservedFieldRenamedMessage,
  reservedNameMessage,
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
    expect(reservedFieldRenamedMessage("hasOwnProperty", "hasOwnProperty_1", "Address", "model")).toBe(
      'The field "hasOwnProperty" was renamed to "hasOwnProperty_1": the name is reserved. It belongs to the model "Address".',
    );
  });
});

describe("reservedNameMessage (the NAME of an entity, a model, an enum, an event ...)", () => {
  it("has the field wording with 'Choose another name.', for exactly the parser-unsafe names, trimmed and case-sensitive", () => {
    for (const name of PARSER_UNSAFE_KEYS) {
      expect(reservedNameMessage(name)).toBe(`"${name}" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.`);
      expect(reservedNameMessage(`  ${name}\t`)).toBe(reservedNameMessage(name));
    }
    for (const name of ["Order", "hasownproperty", "HasOwnProperty", "hasOwnProperty2", "hasOwnProperty_1", "", "valueOf"]) expect(reservedNameMessage(name), name).toBeNull();
  });

  it("is null for anything that is not a string (callers get their input untyped)", () => {
    for (const value of [null, undefined, 5, {}, []]) expect(reservedNameMessage(value as never)).toBeNull();
  });

  it("the field message and the name message say the same thing, only the last words differ", () => {
    for (const name of PARSER_UNSAFE_KEYS) expect(reservedFieldNameMessage(name)?.replace(/field name\.$/, "name.")).toBe(reservedNameMessage(name));
  });
});

describe("renameReservedNames", () => {
  const items = (...names: string[]) => names.map((name) => ({ name }));
  const [UNSAFE] = [...PARSER_UNSAFE_KEYS];

  it("returns the very same array, and no renames, when nothing is reserved", () => {
    const list = items("Order", UNSAFE.toLowerCase());
    const out = renameReservedNames(list, () => { throw new Error("no rename expected"); });
    expect(out.items).toBe(list);
    expect(out.renames.size).toBe(0);
  });

  it("renames to name_1, name_2 ... (not reserved, not used by another item, case-insensitively) and reports each", () => {
    const heard: Array<[string, string]> = [];
    const out = renameReservedNames(items(` ${UNSAFE} `, `${UNSAFE}_1`.toUpperCase(), `${UNSAFE}2`), (from, to) => heard.push([from, to]));
    expect(out.items.map((i) => i.name)).toEqual([`${UNSAFE}_2`, `${UNSAFE}_1`.toUpperCase(), `${UNSAFE}2`]);
    expect(heard).toEqual([[UNSAFE, `${UNSAFE}_2`]]);
    expect([...out.renames]).toEqual([[UNSAFE, `${UNSAFE}_2`]]);
  });

  it("an `extends` that points at a renamed item follows it; one that points elsewhere does not", () => {
    const out = renameReservedNames([{ name: UNSAFE }, { name: "Child", extends: UNSAFE }, { name: "Other", extends: "Base" }]);
    expect(out.items).toEqual([{ name: `${UNSAFE}_1` }, { name: "Child", extends: `${UNSAFE}_1` }, { name: "Other", extends: "Base" }]);
    expect([...out.renames]).toEqual([[UNSAFE, `${UNSAFE}_1`]]);
  });
});
