import { describe, it, expect } from "vitest";
import {
  compareSourceLiterals,
  compareSourceProjection,
  expandBlocks,
  projectRowFields,
  projectSourceFields,
} from "@/lib/entity-versioning/source-projection";

describe("projectSourceFields", () => {
  it("projects the entity's model: field names + logical types (array element included)", () => {
    const source = `
import "@typespec/http";
model Address { line1: string; }
@doc("A customer")
model Customer {
  @key id: string;
  createdAt: utcDateTime;
  tags?: string[];
  address: Address;
  attrs: Record<string>;
}`;
    expect(projectSourceFields(source, "Customer")).toEqual([
      { name: "id", type: "string" },
      { name: "createdAt", type: "utcDateTime" },
      { name: "tags", type: "array<string>" },
      { name: "address", type: "Address" },
      { name: "attrs", type: "map" },
    ]);
  });

  it("matches the model by sanitized name, else falls back to the first model", () => {
    expect(projectSourceFields("model Line_Item { qty: int32; }", "Line Item")).toEqual([{ name: "qty", type: "int32" }]);
    expect(projectSourceFields("model Other { a: string; }", "Missing")).toEqual([{ name: "a", type: "string" }]);
  });

  it("projects nothing for a source without models", () => {
    expect(projectSourceFields("// empty", "Customer")).toEqual([]);
  });
});

describe("projectRowFields", () => {
  it("normalizes row types through the TypeSpec scalar map and keeps the array element type", () => {
    expect(
      projectRowFields([
        { name: "id", type: "string", decorators: {} },
        { name: "tags", type: "array", decorators: { arrayElementType: "string" } },
        { name: "status", type: "Status", decorators: null },
      ])
    ).toEqual([
      { name: "id", type: "string" },
      { name: "tags", type: "array<string>" },
      { name: "status", type: "Status" },
    ]);
  });
});

describe("compareSourceProjection", () => {
  const f = (name: string, type: string) => ({ name, type });

  it("is consistent when names and types agree", () => {
    const stored = [f("id", "string"), f("n", "int32")];
    expect(compareSourceProjection(stored, stored, stored)).toEqual({ differs: false, reasons: [] });
  });

  it("is consistent when the stored type is what the generator renders for the row (lossy generator)", () => {
    // Row type "Status" (an enum name the generator cannot render) is generated as `string`.
    expect(compareSourceProjection([f("status", "string")], [f("status", "Status")], [f("status", "string")]))
      .toEqual({ differs: false, reasons: [] });
  });

  it("is consistent when the stored type equals the row type the TypeSpec save projected", () => {
    expect(compareSourceProjection([f("status", "Status")], [f("status", "Status")], [f("status", "string")]))
      .toEqual({ differs: false, reasons: [] });
  });

  it("differs when a field was added or removed outside the source", () => {
    expect(compareSourceProjection([f("id", "string"), f("old", "string")], [f("id", "string"), f("email", "string")], [f("id", "string"), f("email", "string")]))
      .toEqual({ differs: true, reasons: ['field "email" missing from source', 'field "old" only in source'] });
  });

  it("differs when a field type changed outside the source", () => {
    expect(compareSourceProjection([f("n", "int32")], [f("n", "int64")], [f("n", "int64")]))
      .toEqual({ differs: true, reasons: ['field "n" type: source int32, fields int64'] });
  });

  it("ignores field order", () => {
    expect(compareSourceProjection([f("a", "string"), f("b", "string")], [f("b", "string"), f("a", "string")], []).differs).toBe(false);
  });
});

describe("expandBlocks", () => {
  it("keeps strings and comments intact while splitting one-line blocks", () => {
    const src = 'model A { @doc("x; {y}") a: string; // c; {d}\n b: int32; }';
    expect(projectSourceFields(src, "A")).toEqual([
      { name: "a", type: "string" },
      { name: "b", type: "int32" },
    ]);
  });

  it("does not split inside decorator arguments", () => {
    expect(expandBlocks("@foo(#{k: 1; j: 2}) b: int32;")).toBe("@foo(#{k: 1; j: 2}) b: int32;\n");
  });
});

describe("compareSourceLiterals", () => {
  /** A projected field with the default / example text the source writes. */
  const lit = (name: string, text: { defaultText?: string; exampleText?: string }) => ({ name, type: "int32", ...text });

  it("reads the default and the example the source writes", () => {
    const src = `model T {\n  @example(7)\n  count: int32 = 5;\n}`;
    expect(projectSourceFields(src, "T")).toEqual([{ name: "count", type: "int32", defaultText: "5", exampleText: "7" }]);
  });

  it("flags a literal the generator writes differently: the legacy quoted number, the legacy enum text, a legacy null", () => {
    const stored = [lit("count", { defaultText: '"5"' }), lit("status", { defaultText: '"ACTIVE"' }), lit("gone", { defaultText: "null" })];
    const generated = [lit("count", { defaultText: "5" }), lit("status", { defaultText: "Ticket_status.ACTIVE" }), lit("gone", {})];
    expect(compareSourceLiterals(stored, generated)).toEqual([
      'field "count" default: source "5", generated 5',
      'field "status" default: source "ACTIVE", generated Ticket_status.ACTIVE',
      'field "gone" default: source null, generated none',
    ]);
  });

  it("flags a legacy example that is an identifier or not a value at all, and one the generator does not write, whatever its kind", () => {
    const stored = [lit("name", { exampleText: "Alice" }), lit("tags", { exampleText: "[object Object]" }), lit("count", { exampleText: '"many"' })];
    const generated = [lit("name", { exampleText: '"Alice"' }), lit("tags", {}), lit("count", {})];
    expect(compareSourceLiterals(stored, generated)).toEqual([
      'field "name" example: source Alice, generated "Alice"',
      'field "tags" example: source [object Object], generated none',
      'field "count" example: source "many", generated none',
    ]);
  });

  it("flags a valid literal of another type than the field's, as the compiler would refuse it on the field", () => {
    expect(compareSourceLiterals([lit("code", { exampleText: '"42"' })], [lit("code", { exampleText: "42" })])).toEqual([
      'field "code" example: source "42", generated 42',
    ]);
  });

  it("flags a quoted legacy default that the generator writes unquoted, such as a decimal stored as text", () => {
    expect(compareSourceLiterals([lit("price", { defaultText: '"19.99"' })], [lit("price", { defaultText: "19.99" })])).toEqual([
      'field "price" default: source "19.99", generated 19.99',
    ]);
  });

  it("leaves a literal the generator writes the same way, and a reference or constructor, as written", () => {
    const when = 'utcDateTime.fromISO("2024-05-06T12:20:00Z")';
    const stored = [
      lit("count", { defaultText: "5", exampleText: "7" }),
      lit("status", { defaultText: "Ticket_status.ACTIVE" }),
      lit("when", { defaultText: "utcDateTime.now()", exampleText: when }),
    ];
    const generated = [
      lit("count", { defaultText: "5", exampleText: "7" }),
      lit("status", { defaultText: "Ticket_status.ACTIVE" }),
      lit("when", { defaultText: "utcDateTime.now()", exampleText: when }),
    ];
    expect(compareSourceLiterals(stored, generated)).toEqual([]);
  });

  it("leaves a reference to an enum member as written where the generator writes it, and flags one on a field the enum does not type", () => {
    const stored = [lit("status", { defaultText: "Ticket_status.ACTIVE" }), lit("tag", { exampleText: "Ticket_status.`in-progress`" })];
    const generated = [lit("status", { defaultText: "Ticket_status.ACTIVE" }), lit("tag", { exampleText: "Ticket_status.`in-progress`" })];
    expect(compareSourceLiterals(stored, generated)).toEqual([]);
    // A member reference is a value of its enum only: on a string field the generator writes the text, so the reference is wrong there.
    expect(compareSourceLiterals([lit("name", { defaultText: "Ticket_status.ACTIVE" })], [lit("name", { defaultText: '"ACTIVE"' })])).toEqual([
      'field "name" default: source Ticket_status.ACTIVE, generated "ACTIVE"',
    ]);
    expect(compareSourceLiterals([lit("status", { exampleText: "Ticket_status.NOPE" })], [lit("status", {})])).toEqual([
      'field "status" example: source Ticket_status.NOPE, generated none',
    ]);
  });

  it("flags a legacy example that spans lines: the generator never writes a line break inside a literal, so the example is not the text it writes", () => {
    const stored = projectSourceFields('model Ticket {\n  @example(Dear\nSir)\n  name: string;\n}\n', "Ticket");
    expect(stored).toEqual([{ name: "name", type: "string", exampleText: "Dear\u0000Sir" }]);
    expect(compareSourceLiterals(stored, [lit("name", { exampleText: '"Dear\\nSir"' })])).toHaveLength(1);
  });

  it("flags a constructor the generator writes differently, such as one with an escape TypeSpec does not define", () => {
    const stored = [lit("when", { defaultText: 'utcDateTime.fromISO("\\q")' }), lit("seen", { exampleText: 'utcDateTime.fromISO("2024\\x41")' })];
    expect(compareSourceLiterals(stored, [lit("when", {}), lit("seen", {})])).toEqual([
      'field "when" default: source utcDateTime.fromISO("\\q"), generated none',
      'field "seen" example: source utcDateTime.fromISO("2024\\x41"), generated none',
    ]);
  });

  it("flags free text that is dotted or called with no declared head, such as a name with a dot or a call of a name", () => {
    const texts = ["Dr.Smith", "Mr.Smith", "U.S.A", "Name(s)", "Foo(bar)", "Dr. Smith", "Acme Inc. (EU)"];
    expect(compareSourceLiterals(texts.map((t, i) => lit(`f${i}`, { exampleText: t })), [])).toEqual(
      texts.map((t, i) => `field "f${i}" example: source ${t}, generated none`)
    );
  });

  it("keeps a standard constructor of a date, time or duration as written, and flags one that is not well formed", () => {
    const kept = ["utcDateTime.now()", 'utcDateTime.fromISO("2024-05-06T12:20:00Z")', 'duration.fromISO("P1D")', "plainTime.now()"];
    const broken = [
      "utcDateTime.now",
      "utcDateTime.fromISO(Alice)",
      'utcDateTime.fromISO("a", "b")',
      "utcDateTime.fromISO()",
      "duration.now()",
      'string.fromISO("x")',
      'utcDateTime.fromISO("x").y()',
    ];
    expect(compareSourceLiterals(kept.map((t, i) => lit(`k${i}`, { exampleText: t })), kept.map((t, i) => lit(`k${i}`, { exampleText: t })))).toEqual([]);
    expect(compareSourceLiterals(broken.map((t, i) => lit(`b${i}`, { exampleText: t })), [])).toHaveLength(broken.length);
  });

  it("leaves an example the generator writes the same way, even a list of enum members the reading does not take as a value", () => {
    const labels = '#[Ticket_labels.ACTIVE, Ticket_labels.`in-progress`]';
    expect(compareSourceLiterals([lit("labels", { exampleText: labels })], [lit("labels", { exampleText: labels })])).toEqual([]);
    expect(compareSourceLiterals([lit("labels", { exampleText: labels })], [lit("labels", {})])).toEqual([
      `field "labels" example: source ${labels}, generated none`,
    ]);
  });

  it("flags legacy text the generator would not write, even when it holds a dot or a parenthesis (a JSON list, free text)", () => {
    const stored = [
      lit("urls", { defaultText: '["https://a.com"]' }),
      lit("cfg", { defaultText: '{"ratio": 0.5}' }),
      lit("name", { exampleText: "Dr. Smith" }),
      lit("org", { exampleText: "Acme Inc. (EU)" }),
    ];
    const generated = [
      lit("urls", { defaultText: '#["https://a.com"]' }),
      lit("cfg", { defaultText: '#{ratio: 0.5}' }),
      lit("name", { exampleText: '"Dr. Smith"' }),
      lit("org", { exampleText: '"Acme Inc. (EU)"' }),
    ];
    expect(compareSourceLiterals(stored, generated)).toEqual([
      'field "urls" default: source ["https://a.com"], generated #["https://a.com"]',
      'field "cfg" default: source {"ratio": 0.5}, generated #{ratio: 0.5}',
      'field "name" example: source Dr. Smith, generated "Dr. Smith"',
      'field "org" example: source Acme Inc. (EU), generated "Acme Inc. (EU)"',
    ]);
  });

  it("reports nothing for a stored source with no literals", () => {
    expect(compareSourceLiterals([lit("a", {})], [lit("a", { defaultText: "5" })])).toEqual([]);
  });
});
