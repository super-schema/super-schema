/**
 * The typed value literal: what a stored default or example becomes in TypeSpec text for a given type, what is coerced, and what is withheld.
 * The compile proof runs every literal the formatter writes through the REAL TypeSpec compiler.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  constructorLiteral,
  defaultInput,
  isClearedValue,
  literalFor,
  numberFromText,
  previewLiteral,
  scalarLiteralTarget,
  standardConstructorScalar,
  storedDefaultText,
  type LiteralTarget,
} from "@/lib/compiler/typed-value-literal";

vi.mock("server-only", () => ({}));

let compileTypeSpecWithGovernance: typeof import("@/lib/compiler/typespec-compiler").compileTypeSpecWithGovernance;

beforeAll(async () => {
  ({ compileTypeSpecWithGovernance } = await import("@/lib/compiler/typespec-compiler"));
});

const target = (typeId: string): LiteralTarget => {
  const t = scalarLiteralTarget(typeId);
  if (!t) throw new Error(`no literal target for ${typeId}`);
  return t;
};

const ENUM: LiteralTarget = { kind: "enum", type: "Ticket_status", symbols: ["ACTIVE", "in-progress", "model", "a b", "1", 'say "hi"'] };
/** A union of two literal members, and a union of text and int32. */
const STATUS: LiteralTarget = {
  kind: "union",
  members: [
    { kind: "constant", text: '"a"', value: "a" },
    { kind: "constant", text: '"b"', value: "b" },
  ],
};
const TEXT_OR_INT: LiteralTarget = { kind: "union", members: [target("string"), target("int32")] };

function text(value: unknown, t: LiteralTarget): string {
  const r = literalFor(value, t);
  if (!r.ok) throw new Error(`expected a literal for ${JSON.stringify(value)}, got: ${r.reason}`);
  return r.text;
}

describe("numberFromText", () => {
  it("reads decimal text as the number it prints back as, exactly", () => {
    expect(numberFromText("42")).toBe(42);
    expect(numberFromText(" -1.5 ")).toBe(-1.5);
    expect(numberFromText("1e3")).toBe(1000);
    expect(numberFromText("19.990")).toBe(19.99);
    expect(numberFromText("1e21")).toBe(1e21);
  });

  it("refuses text that is not decimal, that overflows, or that the double cannot hold exactly", () => {
    for (const bad of ["abc", "0x1F", "", "+", ".", "Infinity", "NaN", "1e400", "1_000", "9007199254740993", "0.1000000000000000055511151231257827"]) {
      expect(numberFromText(bad), bad).toBeUndefined();
    }
  });
});

describe("literalFor: numbers", () => {
  it("writes a whole number for an integer type, coerces lossless text, and refuses what does not fit", () => {
    expect(text(5, target("int32"))).toBe("5");
    expect(text("42", target("int32"))).toBe("42");
    expect(text(-2147483648, target("int32"))).toBe("-2147483648");
    expect(literalFor("abc", target("int32"))).toEqual({ ok: false, reason: '"abc" is not a number' });
    expect(literalFor(1.5, target("int32"))).toEqual({ ok: false, reason: "1.5 is not a whole number" });
    expect(literalFor("3000000000", target("int32"))).toEqual({ ok: false, reason: '"3000000000" is outside the range of int32' });
    expect(literalFor(-129, target("int8"))).toEqual({ ok: false, reason: "-129 is outside the range of int8" });
  });

  it("keeps the 64-bit limits exact: a double at 2^63 is past int64, the largest double below it is not", () => {
    expect(literalFor(2 ** 63, target("int64"))).toMatchObject({ ok: false });
    expect(text(9007199254740992, target("int64"))).toBe("9007199254740992");
    expect(text(-(2 ** 63), target("int64"))).toBe("-9223372036854775808");
    expect(literalFor(-(2 ** 63) - 2048, target("int64"))).toMatchObject({ ok: false });
    expect(text(2 ** 64 - 2048, target("uint64"))).toBe("18446744073709549568");
    expect(literalFor(2 ** 64, target("uint64"))).toMatchObject({ ok: false });
    expect(literalFor(-1, target("uint8"))).toMatchObject({ ok: false });
  });

  it("writes a float within its type and refuses a float32 beyond the compiler's 3.4e38 limit", () => {
    expect(text(0.5, target("float64"))).toBe("0.5");
    expect(text(1e-7, target("float"))).toBe("1e-7");
    expect(text(3.4e38, target("float32"))).toBe("3.4e+38");
    expect(literalFor(3.5e38, target("float32"))).toMatchObject({ ok: false });
  });

  it("refuses a non-finite number", () => {
    expect(literalFor(Number.POSITIVE_INFINITY, target("float64"))).toMatchObject({ ok: false });
    expect(literalFor(Number.NaN, target("decimal"))).toMatchObject({ ok: false });
  });
});

describe("literalFor: booleans and text", () => {
  it("writes true and false, and reads the text true and false as them", () => {
    expect(text(true, target("boolean"))).toBe("true");
    expect(text(" false ", target("boolean"))).toBe("false");
    expect(literalFor("yes", target("boolean"))).toEqual({ ok: false, reason: '"yes" is not true or false' });
  });

  it("quotes text and escapes what the TypeSpec scanner reads an escape for", () => {
    expect(text('a"b\\c', target("string"))).toBe('"a\\"b\\\\c"');
    expect(text("line\nbreak\rand\ttab", target("string"))).toBe('"line\\nbreak\\rand\\ttab"');
    expect(text("${x} and $5 and @at and `tick`", target("string"))).toBe('"\\${x} and $5 and @at and `tick`"');
  });

  it("writes other control characters as they are: the scanner reads them unchanged and TypeSpec has no escape for them", () => {
    expect(text("a\u0008b\u000cc", target("url"))).toBe('"a\u0008b\u000cc"');
  });

  it("withholds NUL, which TypeSpec text cannot carry, and writes a number as its text on a text type", () => {
    expect(literalFor("a\u0000b", target("string"))).toMatchObject({ ok: false });
    expect(text(42, target("string"))).toBe('"42"');
  });
});

describe("literalFor: enums, lists and objects", () => {
  it("references the member of the enum; a bare name bare, any other name in backticks", () => {
    expect(text("ACTIVE", ENUM)).toBe("Ticket_status.ACTIVE");
    expect(text("in-progress", ENUM)).toBe("Ticket_status.`in-progress`");
    expect(text("model", ENUM)).toBe("Ticket_status.`model`");
    expect(text("a b", ENUM)).toBe("Ticket_status.`a b`");
    expect(text("1", ENUM)).toBe("Ticket_status.`1`");
    expect(text('say "hi"', ENUM)).toBe("Ticket_status.`say \"hi\"`");
    expect(literalFor("GONE", ENUM)).toEqual({ ok: false, reason: '"GONE" is not a value of Ticket_status' });
  });

  it("writes a list as #[...] and an object as #{...}, with keys that need it in backticks", () => {
    const strings: LiteralTarget = { kind: "array", element: target("string") };
    expect(text(["a", 2], strings)).toBe('#["a", "2"]');
    expect(text([], strings)).toBe("#[]");
    expect(literalFor(["a", null], strings)).toMatchObject({ ok: false });
    const attrs: LiteralTarget = { kind: "record", value: target("int32") };
    expect(text({ "b-c": "7", model: 1 }, attrs)).toBe("#{`b-c`: 7, `model`: 1}");
    expect(literalFor("not a list", strings)).toEqual({ ok: false, reason: '"not a list" is not a list' });
  });

  it("writes any JSON value for an unknown field, and withholds the parts TypeSpec cannot write", () => {
    const any: LiteralTarget = { kind: "any" };
    expect(text({ a: [1, "x", null, true], "b c": {} }, any)).toBe('#{a: #[1, "x", null, true], `b c`: #{}}');
    expect(literalFor(Number.NaN, any)).toMatchObject({ ok: false });
  });

  it("withholds a value nested deeper than the reader accepts", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 80; i++) deep = [deep];
    expect(literalFor(deep, { kind: "any" })).toMatchObject({ ok: false });
  });
});

describe("cleared values and the Default Value input", () => {
  it("treats nothing, an empty text, and blank text on a non-text type as cleared", () => {
    expect(isClearedValue(null, target("int32"))).toBe(true);
    expect(isClearedValue(undefined, target("int32"))).toBe(true);
    expect(isClearedValue("", target("string"))).toBe(true);
    expect(isClearedValue("  ", target("int32"))).toBe(true);
    expect(isClearedValue("  ", target("string"))).toBe(false);
    expect(isClearedValue(0, target("int32"))).toBe(false);
    expect(isClearedValue(false, target("boolean"))).toBe(false);
  });

  it("stores a number or boolean typed, text as text, and a cleared input as cleared", () => {
    expect(defaultInput("5", "int32")).toEqual({ status: "value", value: 5 });
    expect(defaultInput(" 2.5 ", "float64")).toEqual({ status: "value", value: 2.5 });
    expect(defaultInput("true", "boolean")).toEqual({ status: "value", value: true });
    expect(defaultInput("INV-0", "string")).toEqual({ status: "value", value: "INV-0" });
    expect(defaultInput("ACTIVE", "enum")).toEqual({ status: "value", value: "ACTIVE" });
    expect(defaultInput("", "int32")).toEqual({ status: "cleared" });
    expect(defaultInput("  ", "int32")).toEqual({ status: "cleared" });
  });

  it("rejects text that does not fit a numeric or boolean type, with the reason", () => {
    expect(defaultInput("abc", "int32")).toEqual({ status: "rejected", text: "abc", reason: '"abc" is not a number' });
    expect(defaultInput("1.5", "integer")).toEqual({ status: "rejected", text: "1.5", reason: '"1.5" is not a whole number' });
    expect(defaultInput("maybe", "boolean")).toEqual({ status: "rejected", text: "maybe", reason: '"maybe" is not true or false' });
  });

  it("stores a date, time or duration default only as its constructor, and rejects other text with the reason it is not written", () => {
    expect(defaultInput('utcDateTime.fromISO("2024-05-06T12:20:00Z")', "utcDateTime")).toEqual({
      status: "value",
      value: 'utcDateTime.fromISO("2024-05-06T12:20:00Z")',
    });
    expect(defaultInput(" utcDateTime.now() ", "utcDateTime")).toEqual({ status: "value", value: "utcDateTime.now()" });
    expect(defaultInput("  ", "utcDateTime")).toEqual({ status: "cleared" });
    expect(defaultInput("2024-05-06T12:20:00Z", "utcDateTime")).toEqual({
      status: "rejected",
      text: "2024-05-06T12:20:00Z",
      reason: '"2024-05-06T12:20:00Z" is not a utcDateTime value; TypeSpec writes one as utcDateTime.fromISO("…") or utcDateTime.now()',
    });
    expect(defaultInput("P1D", "duration")).toMatchObject({ status: "rejected", text: "P1D" });
    expect(defaultInput("x", "bytes")).toEqual({ status: "rejected", text: "x", reason: "a bytes field has no literal form in TypeSpec text" });
    // A type whose literal depends on the field is not judged here: its members are checked when the generator writes it.
    expect(defaultInput("GONE", "enum")).toEqual({ status: "value", value: "GONE" });
  });
});

describe("exact integers, radix text and names", () => {
  it("writes the exact digits of a 64-bit limit: the decimal text is judged, not the double it rounds to", () => {
    expect(text("9223372036854775807", target("int64"))).toBe("9223372036854775807");
    expect(literalFor("9223372036854775807", target("int64"))).toMatchObject({ ok: true, value: "9223372036854775807" });
    expect(text("-9223372036854775808", target("int64"))).toBe("-9223372036854775808");
    expect(text("18446744073709551615", target("uint64"))).toBe("18446744073709551615");
    expect(literalFor("9223372036854775808", target("int64"))).toEqual({ ok: false, reason: '"9223372036854775808" is outside the range of int64' });
    expect(literalFor("-1", target("uint64"))).toMatchObject({ ok: false });
  });

  it("writes a whole number held as a double as the exact value the double holds, not the shortest text that reads back as it", () => {
    expect(text(2 ** 60, target("int64"))).toBe("1152921504606846976");
    expect(text(-(2 ** 60), target("int64"))).toBe("-1152921504606846976");
    expect(text(2 ** 64 - 2048, target("uint64"))).toBe("18446744073709549568");
    expect(text(1e21, target("integer"))).toBe("1000000000000000000000");
  });

  it("writes a documentation example past 2^53 in the text the compiler reads back, and withholds one whose rounded text is out of range", () => {
    expect(previewLiteral(2 ** 60, "int64")).toMatchObject({ ok: true, text: "1152921504606847000" });
    expect(literalFor(1234567890123456789, target("int64"), 1, true)).toMatchObject({ ok: true, text: "1234567890123456800" });
    expect(literalFor("9007199254740993", target("int64"), 1, true)).toMatchObject({ ok: true, text: "9007199254740992" });
    expect(literalFor([2 ** 60], { kind: "array", element: target("int64") }, 1, true)).toMatchObject({
      ok: true,
      text: "#[1152921504606847000]",
    });
    expect(literalFor("9223372036854775807", target("int64"), 1, true)).toEqual({
      ok: false,
      reason: '"9223372036854775807" cannot be written exactly as an example: its nearest number is outside the range of int64',
    });
    expect(literalFor("9223372036854775808", target("int64"), 1, true)).toEqual({
      ok: false,
      reason: '"9223372036854775808" is outside the range of int64',
    });
    expect(literalFor(2 ** 60, target("int64"))).toMatchObject({ ok: true, text: "1152921504606846976" });
  });

  it("writes exponent text as its digits, and refuses text with a fraction", () => {
    expect(text("1e3", target("int32"))).toBe("1000");
    expect(text("-1.50e1", target("int32"))).toBe("-15");
    expect(literalFor("1.5e0", target("int32"))).toEqual({ ok: false, reason: '"1.5e0" is not a whole number' });
  });

  it("reads the radix text the quick editors read as a number, and writes its decimal digits", () => {
    expect(text("0x1F", target("int32"))).toBe("31");
    expect(text("0b101", target("float64"))).toBe("5");
    expect(defaultInput("0x1F", "int32")).toEqual({ status: "value", value: 31 });
  });

  it("writes a decimal default as its exact digits in fixed notation, and withholds a decimal example the compiler reads as a double", () => {
    expect(text("1.23456789012345678", target("decimal"))).toBe("1.23456789012345678");
    expect(defaultInput("1.23456789012345678", "decimal")).toEqual({ status: "value", value: "1.23456789012345678" });
    expect(text("1.23456789012345678e20", target("decimal128"))).toBe("123456789012345678000");
    expect(text("0.1000000000000000055511151231257827", target("numeric"))).toBe("0.1000000000000000055511151231257827");
    expect(text("19.99", target("decimal"))).toBe("19.99");
    expect(literalFor("1.23456789012345678", target("decimal"), 1, true)).toEqual({
      ok: false,
      reason: '"1.23456789012345678" cannot be held exactly as a number',
    });
  });

  it("refuses text too long to write, without expanding it", () => {
    expect(literalFor("1e999999999", target("integer"))).toEqual({ ok: false, reason: '"1e999999999" is too long to write' });
  });

  it("references an enum member only by a name in Unicode NFC form, and withholds a key that is not", () => {
    const composed = "Café";
    const decomposed = "Café";
    const drink: LiteralTarget = { kind: "enum", type: "Drink", symbols: [composed, decomposed] };
    expect(text(composed, drink)).toBe("Drink.`Café`");
    expect(literalFor(decomposed, drink)).toEqual({ ok: false, reason: `"${decomposed}" is not in Unicode NFC form, so TypeSpec cannot reference it` });
    expect(literalFor({ [decomposed]: 1 }, { kind: "record", value: target("int32") })).toMatchObject({ ok: false });
  });
});

describe("union literals", () => {
  it("writes a listed literal as that literal, and withholds any other text", () => {
    expect(text("a", STATUS)).toBe('"a"');
    expect(text("b", STATUS)).toBe('"b"');
    expect(literalFor("c", STATUS)).toEqual({ ok: false, reason: '"c" is not a value of the union' });
  });

  it("takes the member a value is as it is: text stays text, a number stays a number", () => {
    expect(text("5", TEXT_OR_INT)).toBe('"5"');
    expect(text("x", TEXT_OR_INT)).toBe('"x"');
    expect(text(5, TEXT_OR_INT)).toBe("5");
    expect(text(1.5, TEXT_OR_INT)).toBe('"1.5"');
  });

  it("withholds a value no member takes", () => {
    expect(literalFor({ a: 1 }, TEXT_OR_INT)).toEqual({ ok: false, reason: "an object is not a value of the union" });
  });
});

describe("date, time and duration constructors", () => {
  it("reads a constructor call of its own scalar: fromISO with one quoted text, now with none", () => {
    expect(standardConstructorScalar("utcDateTime.now()")).toBe("utcDateTime");
    expect(standardConstructorScalar('utcDateTime.fromISO("2024-05-06T12:20:00Z")')).toBe("utcDateTime");
    expect(standardConstructorScalar('duration.fromISO("P1D")')).toBe("duration");
    expect(standardConstructorScalar(' plainTime.now() ')).toBe("plainTime");
  });

  it("refuses what is not a standard constructor: a method the scalar lacks, a non-text argument, a bare name, free text", () => {
    for (const text of [
      "duration.now()",
      "utcDateTime.now",
      "utcDateTime.fromISO(Alice)",
      'utcDateTime.fromISO("a", "b")',
      "utcDateTime.fromISO()",
      'string.fromISO("x")',
      'utcDateTime.fromISO("x").y()',
      "Dr.Smith",
      "toString.x()",
    ]) {
      expect(standardConstructorScalar(text), text).toBeUndefined();
    }
  });

  it("writes a constructor for its own type as the text, and withholds one for another type or free text, with the forms it takes", () => {
    expect(constructorLiteral("utcDateTime.now()", "utcDateTime")).toEqual({ ok: true, text: "utcDateTime.now()", value: "utcDateTime.now()" });
    expect(constructorLiteral('duration.fromISO("P1D")', "utcDateTime")).toEqual({
      ok: false,
      reason: '"duration.fromISO(\\"P1D\\")" is not a utcDateTime value; TypeSpec writes one as utcDateTime.fromISO("…") or utcDateTime.now()',
    });
    expect(constructorLiteral("2024-05-06T12:20:00Z", "duration")).toEqual({
      ok: false,
      reason: '"2024-05-06T12:20:00Z" is not a duration value; TypeSpec writes one as duration.fromISO("…")',
    });
    expect(constructorLiteral("x", "bytes")).toEqual({ ok: false, reason: "a bytes field has no literal form in TypeSpec text" });
    expect(constructorLiteral("x", "toString")).toEqual({ ok: false, reason: "a toString field has no literal form in TypeSpec text" });
  });

  it("writes the constructor's text from the text it holds, so its escapes are the ones TypeSpec reads", () => {
    expect(constructorLiteral('utcDateTime.fromISO("a\\"b")', "utcDateTime")).toEqual({
      ok: true,
      text: 'utcDateTime.fromISO("a\\"b")',
      value: 'utcDateTime.fromISO("a\\"b")',
    });
    expect(constructorLiteral('utcDateTime.fromISO("2024\\n")', "utcDateTime")).toMatchObject({ ok: true, text: 'utcDateTime.fromISO("2024\\n")' });
    expect(constructorLiteral('utcDateTime.fromISO("a\tb")', "utcDateTime")).toMatchObject({ ok: true, text: 'utcDateTime.fromISO("a\\tb")' });
    expect(constructorLiteral("utcDateTime.now( )", "utcDateTime")).toMatchObject({ ok: true, text: "utcDateTime.now()" });
    expect(constructorLiteral('utcDateTime.fromISO("A")', "utcDateTime")).toMatchObject({ ok: true, text: 'utcDateTime.fromISO("A")' });
  });

  it("withholds a constructor whose text TypeSpec cannot read: an escape it does not define, a raw line break, or a NUL", () => {
    for (const text of ['utcDateTime.fromISO("\\q")', 'utcDateTime.fromISO("\\x41")', 'utcDateTime.fromISO("2024\n")', 'utcDateTime.fromISO("a\u0000b")']) {
      expect(constructorLiteral(text, "utcDateTime"), text).toMatchObject({ ok: false });
      expect(defaultInput(text, "utcDateTime"), text).toMatchObject({ status: "rejected" });
      expect(standardConstructorScalar(text), text).toBeUndefined();
    }
    expect(constructorLiteral('utcDateTime.fromISO("\\q")', "utcDateTime")).toEqual({
      ok: false,
      reason: '"utcDateTime.fromISO(\\"\\\\q\\")" holds a text TypeSpec cannot read (an escape it does not define, a line break or a NUL character)',
    });
  });

  it("previews a date example as the constructor the generator writes, and an enum or list example as not previewed", () => {
    expect(previewLiteral('utcDateTime.fromISO("2024-05-06T12:20:00Z")', "utcDateTime")).toEqual({
      ok: true,
      text: 'utcDateTime.fromISO("2024-05-06T12:20:00Z")',
      value: 'utcDateTime.fromISO("2024-05-06T12:20:00Z")',
    });
    expect(previewLiteral("2024-05-06T12:20:00Z", "utcDateTime")).toMatchObject({ ok: false });
    expect(previewLiteral("GONE", "enum")).toBeUndefined();
  });
});

describe("the number a stored default shows as", () => {
  it("shows a whole number past 2^53 on an integer type as the exact digits the generator writes, and other values as String() shows them", () => {
    expect(storedDefaultText(2 ** 60, "int64")).toBe("1152921504606846976");
    expect(storedDefaultText(2 ** 60, "float64")).toBe(String(2 ** 60));
    expect(storedDefaultText(5, "int32")).toBe("5");
    expect(storedDefaultText(true, "boolean")).toBe("true");
    expect(storedDefaultText("abc", "string")).toBe("abc");
    expect(storedDefaultText(null, "int32")).toBe("");
    expect(storedDefaultText(undefined, "int32")).toBe("");
  });
});

describe("the literals the formatter writes compile in the real TypeSpec compiler", () => {
  it("every typed literal, for every target, is accepted by the installed compiler", async () => {
    const cases: Array<[string, LiteralTarget, unknown]> = [
      ["int8", target("int8"), -128],
      ["int16", target("int16"), "32767"],
      ["int32", target("int32"), -2147483648],
      ["int64", target("int64"), 9007199254740992],
      ["int64", target("int64"), 2 ** 60],
      ["int64", target("int64"), -(2 ** 63)],
      ["uint64", target("uint64"), 2 ** 64 - 2048],
      ["uint8", target("uint8"), 255],
      ["uint16", target("uint16"), 65535],
      ["uint32", target("uint32"), 4294967295],
      ["uint64", target("uint64"), 0],
      ["safeint", target("safeint"), -9007199254740991],
      ["integer", target("integer"), 1e21],
      ["numeric", target("numeric"), 1.5e300],
      ["float", target("float"), 1e-7],
      ["float32", target("float32"), 3.4e38],
      ["float64", target("float64"), 5e-324],
      ["decimal", target("decimal"), "19.99"],
      ["decimal128", target("decimal128"), -0.5],
      ["boolean", target("boolean"), true],
      ["boolean", target("boolean"), "false"],
      ["string", target("string"), 'quote " back \\ newline \n tab \t dollar ${x} at @ tick `'],
      ["string", target("string"), "bell \u0008 form \u000c end"],
      ["url", target("url"), "https://example.com/a?b=c"],
      ["string", target("string"), 42],
      ["int64", target("int64"), "9223372036854775807"],
      ["int64", target("int64"), "-9223372036854775808"],
      ["uint64", target("uint64"), "18446744073709551615"],
      ["int32", target("int32"), "0x1F"],
      ["decimal", target("decimal"), "1.23456789012345678"],
      ["decimal128", target("decimal128"), "1.23456789012345678e20"],
      ["numeric", target("numeric"), "0.1000000000000000055511151231257827"],
    ];
    const lines = cases.map(([type, t, value], i) => `  p${i}: ${type} = ${text(value, t)};`);
    const enumCase = text("in-progress", ENUM);
    const source = [
      "enum Ticket_status {",
      '  ACTIVE,',
      '  "in-progress",',
      '  "model",',
      '  "a b",',
      '  "1",',
      '  "say \\"hi\\"",',
      "}",
      "",
      "model Ticket {",
      ...lines,
      `  e0: Ticket_status = ${enumCase};`,
      `  e1: Ticket_status = ${text("ACTIVE", ENUM)};`,
      `  e2: Ticket_status = ${text("model", ENUM)};`,
      `  e3: Ticket_status = ${text("a b", ENUM)};`,
      `  e4: Ticket_status = ${text("1", ENUM)};`,
      `  e5: Ticket_status = ${text('say "hi"', ENUM)};`,
      `  tags: string[] = ${text(["a", 2], { kind: "array", element: target("string") })};`,
      `  scores: int32[] = ${text(["1", 2], { kind: "array", element: target("int32") })};`,
      `  attrs: Record<int32> = ${text({ "b-c": "7", model: 1 }, { kind: "record", value: target("int32") })};`,
      `  anything: unknown = ${text({ a: [1, "x", null, true], "b c": {} }, { kind: "any" })};`,
      `  s1: "a" | "b" = ${text("a", STATUS)};`,
      `  s2: "a" | "b" = ${text("b", STATUS)};`,
      `  s3: string | int32 = ${text("x", TEXT_OR_INT)};`,
      `  s4: string | int32 = ${text(5, TEXT_OR_INT)};`,
      `  s5: string | int32 = ${text("5", TEXT_OR_INT)};`,
      `  s6: string | int32 = ${text(1.5, TEXT_OR_INT)};`,
      "}",
      "",
    ].join("\n");
    const result = await compileTypeSpecWithGovernance(source);
    if (!result.success) {
      throw new Error(`does not compile:\n${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n---\n${source}`);
    }
    expect(result.success).toBe(true);
  }, 60_000);

  it("every constructor the default input stores compiles, and every text it refuses is one the compiler does not read as a value", async () => {
    // Stored texts (as the Default Value input receives them). A text with an escape TypeSpec does not define, or a raw line break, is refused.
    const stored = [
      'utcDateTime.fromISO("A")',
      'utcDateTime.fromISO("a\\"b")',
      'utcDateTime.fromISO("2024\\n")',
      'utcDateTime.fromISO("a\\\\b")',
      'utcDateTime.fromISO("a\tb")',
      "utcDateTime.now()",
      'utcDateTime.fromISO("\\q")',
      'utcDateTime.fromISO("\\x41")',
      'utcDateTime.fromISO("2024\n")',
    ];
    const values: string[] = [];
    for (const input of stored) {
      const r = defaultInput(input, "utcDateTime");
      if (r.status === "value") values.push(r.value as string);
      else expect(r.status, input).toBe("rejected");
    }
    expect(values).toHaveLength(6);
    const source = ["model Ticket {", ...values.map((v, i) => `  d${i}: utcDateTime = ${v};`), "}", ""].join("\n");
    const result = await compileTypeSpecWithGovernance(source);
    if (!result.success) {
      throw new Error(`does not compile:\n${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}\n---\n${source}`);
    }
    expect(result.success).toBe(true);
  }, 60_000);
});
