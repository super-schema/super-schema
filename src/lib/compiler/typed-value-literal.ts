/**
 * TypeSpec literals for the values a person stores on a field: the default (`= …`) and the documentation example (`@example(…)`).
 *
 * What is stored is whatever the Field Studio, the quick editor or the Documentation panel kept: a number, a boolean, text, a parsed JSON
 * list or object, or nothing. TypeSpec checks a literal against the type of the property it sits on, so `count: int32 = "0"`, an enum
 * default written as text, or `@example(42)` on a string field are all `unassignable`. Each literal is therefore written for the type it
 * lands on: coerced when that is lossless (`"42"` on an int32 is `42`), and withheld when it is not (`"abc"` on an int32, `1.5`, a value
 * past the range). tests/unit/lib/compiler/typed-value-literal.test.ts compiles every literal this module writes.
 *
 * Pure: no I/O and no framework imports, so the generator and the editors that store the values apply the same rules.
 */
import { INTEGER_RANGES } from "./constraint-targets";
import { MAX_LITERAL_DEPTH } from "./governance-decorators";
import { escapeString, isPlainIdentifier, quoteIdentifier } from "./typespec-identifiers";

/** What a literal must be for the type it is written into. */
export type LiteralTarget =
  | { kind: "string" }
  | { kind: "boolean" }
  /** A whole number of the named TypeSpec type (`integer` is unbounded; the fixed-width types have the compiler's range). */
  | { kind: "integer"; type: string }
  /** A finite number of the named type; `magnitude` caps it where the compiler does (float32 is ±3.4e38). */
  | { kind: "number"; type: string; magnitude?: number }
  /** A member of the enum `type` (its TypeSpec name), one of `symbols`: the values the enum declares. */
  | { kind: "enum"; type: string; symbols: readonly string[] }
  /** `T[]`. */
  | { kind: "array"; element: LiteralTarget }
  /** `Record<T>`: an object whose members are `T`. */
  | { kind: "record"; value: LiteralTarget }
  /** `unknown`: any JSON value. */
  | { kind: "any" }
  /** One value the type takes exactly: a literal member of a union (`"a"`, `1`, `true`). `text` is the literal as TypeSpec writes it. */
  | { kind: "constant"; text: string; value: string | number | boolean }
  /** A union: a value that one of its members takes is written as that member takes it (see {@link unionLiteral}). */
  | { kind: "union"; members: readonly LiteralTarget[] };

type ArrayTarget = Extract<LiteralTarget, { kind: "array" }>;
type RecordTarget = Extract<LiteralTarget, { kind: "record" }>;
type IntegerTarget = Extract<LiteralTarget, { kind: "integer" }>;
type NumericTarget = Extract<LiteralTarget, { kind: "integer" | "number" }>;
type EnumTarget = Extract<LiteralTarget, { kind: "enum" }>;
type ConstantTarget = Extract<LiteralTarget, { kind: "constant" }>;
type UnionTarget = Extract<LiteralTarget, { kind: "union" }>;

/** A literal as TypeSpec text, and the value it stands for (a number, a boolean or text for a scalar; the list or object otherwise). */
export type Literal = { ok: true; text: string; value: unknown } | { ok: false; reason: string };

/** The compiler's own float32 range (`numericRanges.float32` in @typespec/compiler): ±3.4e38. */
const FLOAT32_MAGNITUDE = 3.4e38;

const SCALAR_TARGETS: Readonly<Record<string, LiteralTarget>> = {
  string: { kind: "string" },
  url: { kind: "string" },
  boolean: { kind: "boolean" },
  integer: { kind: "integer", type: "integer" },
  int8: { kind: "integer", type: "int8" },
  int16: { kind: "integer", type: "int16" },
  int32: { kind: "integer", type: "int32" },
  int64: { kind: "integer", type: "int64" },
  safeint: { kind: "integer", type: "safeint" },
  uint8: { kind: "integer", type: "uint8" },
  uint16: { kind: "integer", type: "uint16" },
  uint32: { kind: "integer", type: "uint32" },
  uint64: { kind: "integer", type: "uint64" },
  numeric: { kind: "number", type: "numeric" },
  float: { kind: "number", type: "float" },
  float32: { kind: "number", type: "float32", magnitude: FLOAT32_MAGNITUDE },
  float64: { kind: "number", type: "float64" },
  decimal: { kind: "number", type: "decimal" },
  decimal128: { kind: "number", type: "decimal128" },
};

/**
 * The literal target of a scalar logical type, or undefined when TypeSpec text has no literal for it (a date or time, bytes, a custom
 * name): a value stored for such a field is withheld, with a warning from the generator.
 */
export function scalarLiteralTarget(typeId: string): LiteralTarget | undefined {
  return Object.prototype.hasOwnProperty.call(SCALAR_TARGETS, typeId) ? SCALAR_TARGETS[typeId] : undefined;
}

/**
 * The constructors the date, time and duration scalars take as values: `utcDateTime.fromISO("…")` and `utcDateTime.now()`. TypeSpec text has no
 * other value of those types, and the compiler takes these calls as they are (it does not check the text they hold), so they are written as typed.
 */
const STANDARD_CONSTRUCTORS: Readonly<Record<string, readonly string[]>> = {
  plainDate: ["fromISO", "now"],
  plainTime: ["fromISO", "now"],
  utcDateTime: ["fromISO", "now"],
  offsetDateTime: ["fromISO", "now"],
  duration: ["fromISO"],
};

const CONSTRUCTOR_CALL = /^([A-Za-z_]\w*)\.(\w+)\(([\s\S]*)\)$/;

/** One quoted TypeSpec string: no quote, backslash, line break or NUL, except in an escape TypeSpec defines (`\"`, `\\`, `\n`, `\$`, ...). */
const QUOTED_TEXT = /^"((?:[^"\\\r\n\u0000]|\\[\\"nrt$@`])*)"$/;
const TYPESPEC_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

/**
 * The text a quoted TypeSpec string holds, read as TypeSpec reads it. Undefined for an escape TypeSpec does not define (`\q`, `\x41`), a raw
 * line break or NUL, or text that is not one quoted string: the compiler refuses each of those.
 */
function readQuotedText(quoted: string): string | undefined {
  const m = QUOTED_TEXT.exec(quoted.trim());
  return m ? m[1].replace(/\\([\s\S])/g, (_escape, ch: string) => TYPESPEC_ESCAPES[ch] ?? ch) : undefined;
}

/** The parts of a standard constructor call (`scalar.method(args)`) for a known scalar and method; undefined for any other text. */
function constructorShape(text: string): { scalar: string; method: string; args: string } | undefined {
  const m = CONSTRUCTOR_CALL.exec(text.trim());
  if (!m || !Object.prototype.hasOwnProperty.call(STANDARD_CONSTRUCTORS, m[1])) return undefined;
  if (!STANDARD_CONSTRUCTORS[m[1]].includes(m[2])) return undefined;
  return { scalar: m[1], method: m[2], args: m[3].trim() };
}

/**
 * The scalar a text is a standard constructor call of (`utcDateTime` for `utcDateTime.fromISO("2024-05-06T12:20:00Z")`), or undefined. `fromISO`
 * takes exactly one quoted text that TypeSpec reads (see {@link readQuotedText}), and `now` nothing. The date is not read, as the compiler does not
 * read it either.
 */
export function standardConstructorScalar(text: string): string | undefined {
  const shape = constructorShape(text);
  if (!shape) return undefined;
  if (shape.method === "now") return shape.args === "" ? shape.scalar : undefined;
  return readQuotedText(shape.args) !== undefined ? shape.scalar : undefined;
}

/**
 * True when a stored default or example means "none": nothing (`null`, `undefined`), an empty text, or blank text on a type whose values are
 * not text (blank is no number, no boolean, no member). Text on a text type is a value, even when it is only spaces.
 */
export function isClearedValue(value: unknown, target: LiteralTarget | undefined): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string" || value.trim() !== "") return false;
  return !takesText(target);
}

/** Whether text is a value of the type: a text type, `unknown`, or a union with one of those among its members. */
function takesText(target: LiteralTarget | undefined): boolean {
  if (target === undefined) return false;
  if (target.kind === "string" || target.kind === "any") return true;
  return target.kind === "union" && target.members.some(takesText);
}

/** Decimal text: an optional sign, digits with an optional fraction, an optional exponent. */
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** The exact decimal the text reads as, normalised (`1.50e3` and `1500` are both `15e2`); undefined when the text is not decimal. */
function decimalForm(text: string): string | undefined {
  const m = DECIMAL_TEXT.exec(text);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return undefined;
  const fraction = m[3] ?? "";
  const digits = (m[2] + fraction).replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  if (significant === "") return "0";
  const exponent = Number(m[4] ?? "0") - fraction.length + (digits.length - significant.length);
  return `${m[1] === "-" ? "-" : ""}${significant}e${exponent}`;
}

/**
 * The number decimal text reads as, when the double prints back as the same decimal: `"19.990"` and `"1e3"` yes; `"9007199254740993"` (past
 * what a double holds), `"0x1F"`, `"1e400"` no. The reason says which.
 */
function readNumberText(text: string): { value: number } | { reason: string } {
  const t = text.trim();
  if (decimalForm(t) === undefined) return { reason: "is not a number" };
  const n = Number(t);
  if (!Number.isFinite(n)) return { reason: "is outside the range of a number" };
  if (decimalForm(String(n)) !== decimalForm(t)) return { reason: "cannot be held exactly as a number" };
  return { value: n };
}

/** The number `text` reads as (see {@link readNumberText}), or undefined. */
export function numberFromText(text: string): number | undefined {
  const read = readNumberText(text);
  return "value" in read ? read.value : undefined;
}

/** The decimal types, which hold any digits exactly (a default written as digits keeps them). */
const DECIMAL_TYPES = new Set(["numeric", "decimal", "decimal128"]);

/**
 * The exact digits of a decimal text in fixed notation, as TypeSpec writes a decimal literal (`1.5e3` is `1500`, `1e-3` is `0.001`); undefined when
 * the text is not decimal or is too long to write (see {@link MAX_WHOLE_DIGITS}).
 */
function exactDecimalText(text: string): string | undefined {
  const form = decimalForm(text);
  if (form === undefined) return undefined;
  const m = /^(-?)(\d+)e(-?\d+)$/.exec(form);
  if (!m) return "0";
  const digits = m[2];
  const point = digits.length + Number(m[3]); // the number of digits before the decimal point
  if (digits.length > MAX_WHOLE_DIGITS || Math.abs(point) > MAX_WHOLE_DIGITS) return undefined;
  let fixed: string;
  if (point <= 0) fixed = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) fixed = digits + "0".repeat(point - digits.length);
  else fixed = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${m[1]}${fixed}`;
}

/** Radix text the quick editors read as a number (`0x1F`, `0o17`, `0b101`), which TypeSpec has no literal for: written as its decimal digits. */
const RADIX_TEXT = /^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$/;

/** The most digits a whole number is written with: past it the text is refused, so a text such as `1e999999999` is never expanded. */
const MAX_WHOLE_DIGITS = 1000;

/**
 * The digits (with an optional minus) of a normalised decimal form (see {@link decimalForm}) that is a whole number, `"fraction"` when it has a
 * fractional part, or `"long"` when it has more digits than {@link MAX_WHOLE_DIGITS}.
 */
function wholeDigits(form: string): string | "fraction" | "long" {
  if (form === "0") return "0";
  const m = /^(-?)(\d+)e(-?\d+)$/.exec(form);
  if (!m) return "fraction";
  const exponent = Number(m[3]);
  if (exponent < 0) return "fraction";
  if (m[2].length + exponent > MAX_WHOLE_DIGITS) return "long";
  return `${m[1]}${m[2]}${"0".repeat(exponent)}`;
}

/** The number a `number` target takes text as (see {@link numericLiteral}); the double is exact for it. */
const FLOAT64: NumericTarget = { kind: "number", type: "float64" };

/** A value as a person reads it in a reason: text quoted (and shortened), a list or an object by its kind. */
function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (Array.isArray(value)) return "a list";
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A name as TypeSpec writes it where a bare identifier is taken (an enum member, a literal object key): bare when it can be, else in backticks. */
function identifierLiteral(name: string): string {
  return isPlainIdentifier(name) ? name : quoteIdentifier(name);
}

function stringLiteral(value: unknown): Literal {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) text = String(value);
  else return { ok: false, reason: `${show(value)} is not text` };
  if (text.includes("\u0000")) return { ok: false, reason: "contains a NUL character, which TypeSpec text cannot carry" };
  // TypeSpec reads `\"`, `\\`, `\n`, `\r`, `\t`, `\$`, `\@` and `` \` `` as escapes and has no other: the rest is written as it is.
  return { ok: true, text: `"${escapeString(text)}"`, value: text };
}

function booleanLiteral(value: unknown): Literal {
  if (typeof value === "boolean") return { ok: true, text: String(value), value };
  const word = typeof value === "string" ? value.trim() : "";
  if (word === "true" || word === "false") return { ok: true, text: word, value: word === "true" };
  return { ok: false, reason: `${show(value)} is not true or false` };
}

/**
 * An integer type's literal: the exact digits of the whole number, judged as decimal text (so `9223372036854775807` is int64's maximum, not
 * the double 2^63). A number value stays the number it is; text stays exact: a number when a double holds it exactly, its digits otherwise.
 * A documentation example is a decorator argument, which the compiler reads as a double: past 2^53 it accepts only the text the double prints
 * as (`1152921504606847000` for 2^60; the exact digits throw), so that text is written, and the range is judged on it.
 */
function integerLiteral(value: unknown, target: IntegerTarget, example: boolean): Literal {
  let digits: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: `${show(value)} is not a finite number` };
    if (!Number.isInteger(value)) return { ok: false, reason: `${show(value)} is not a whole number` };
    // The double's exact value: String() gives the shortest text that reads back as the double, which past 2^53 is not the double (2^60 is
    // 1152921504606846976, not 1152921504606847000).
    digits = BigInt(value).toString();
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const form = decimalForm(RADIX_TEXT.test(trimmed) ? BigInt(trimmed).toString() : trimmed);
    if (form === undefined) return { ok: false, reason: `${show(value)} is not a number` };
    const whole = wholeDigits(form);
    if (whole === "fraction") return { ok: false, reason: `${show(value)} is not a whole number` };
    if (whole === "long") return { ok: false, reason: `${show(value)} is too long to write` };
    digits = whole;
  } else {
    return { ok: false, reason: `${show(value)} is not a number` };
  }
  let written = digits;
  if (example && !Number.isSafeInteger(Number(digits))) {
    written = String(Number(digits));
    if (!/^-?\d+$/.test(written)) return { ok: false, reason: `${show(value)} is too large to write as an example` };
  }
  const big = BigInt(written);
  const range = INTEGER_RANGES[target.type] as readonly [bigint, bigint] | undefined;
  if (range && (big < range[0] || big > range[1])) {
    const exact = BigInt(digits);
    if (exact >= range[0] && exact <= range[1]) {
      // The number is in range; only the text an example is written as (its double) is not, and the compiler takes no other text for it.
      return { ok: false, reason: `${show(value)} cannot be written exactly as an example: its nearest number is outside the range of ${target.type}` };
    }
    return { ok: false, reason: `${show(value)} is outside the range of ${target.type}` };
  }
  if (typeof value === "number") return { ok: true, text: written, value };
  return { ok: true, text: written, value: Number.isSafeInteger(Number(digits)) ? Number(digits) : digits };
}

function numericLiteral(value: unknown, target: NumericTarget, example: boolean): Literal {
  if (target.kind === "integer") return integerLiteral(value, target, example);
  let n: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: `${show(value)} is not a finite number` };
    n = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const text = RADIX_TEXT.test(trimmed) ? BigInt(trimmed).toString() : trimmed;
    const read = readNumberText(text);
    if (!("value" in read)) {
      // A decimal type holds the digits exactly, so a default is written as they are. An example is a decorator argument the compiler reads as a
      // double, and it throws on digits a double cannot hold, so such an example is withheld.
      if (example || !DECIMAL_TYPES.has(target.type) || decimalForm(text) === undefined) {
        return { ok: false, reason: `${show(value)} ${read.reason}` };
      }
      const exact = exactDecimalText(text);
      return exact === undefined ? { ok: false, reason: `${show(value)} is too long to write` } : { ok: true, text: exact, value: exact };
    }
    n = read.value;
  } else {
    return { ok: false, reason: `${show(value)} is not a number` };
  }
  if (target.magnitude !== undefined && Math.abs(n) > target.magnitude) {
    return { ok: false, reason: `${show(value)} is outside the range of ${target.type}` };
  }
  return { ok: true, text: String(n), value: n };
}

function enumLiteral(value: unknown, target: EnumTarget): Literal {
  const symbol =
    typeof value === "string"
      ? value
      : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean"
        ? String(value)
        : undefined;
  if (symbol === undefined || symbol.includes("\u0000") || !target.symbols.includes(symbol)) {
    return { ok: false, reason: `${show(value)} is not a value of ${target.type}` };
  }
  // TypeSpec reads a backticked name in Unicode NFC form, while a member is declared as the text it was given: a name that is not NFC has no reference.
  if (symbol.normalize("NFC") !== symbol) return { ok: false, reason: `${show(value)} is not in Unicode NFC form, so TypeSpec cannot reference it` };
  return { ok: true, text: `${target.type}.${identifierLiteral(symbol)}`, value: symbol };
}

function arrayLiteral(value: unknown, target: ArrayTarget, depth: number, example: boolean): Literal {
  if (!Array.isArray(value)) return { ok: false, reason: `${show(value)} is not a list` };
  const texts: string[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = literalFor(value[i], target.element, depth + 1, example);
    if (!item.ok) return { ok: false, reason: `item ${i + 1}: ${item.reason}` };
    texts.push(item.text);
    values.push(item.value);
  }
  return { ok: true, text: `#[${texts.join(", ")}]`, value: values };
}

function recordLiteral(value: unknown, target: RecordTarget, depth: number, example: boolean): Literal {
  if (!isPlainObject(value)) return { ok: false, reason: `${show(value)} is not an object` };
  const members: string[] = [];
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue; // an undefined member is no member
    if (key.includes("\u0000")) return { ok: false, reason: "a key contains a NUL character, which TypeSpec text cannot carry" };
    if (key.normalize("NFC") !== key) return { ok: false, reason: `the key ${show(key)} is not in Unicode NFC form, which TypeSpec reads keys in` };
    const item = literalFor(member, target.value, depth + 1, example);
    if (!item.ok) return { ok: false, reason: `${key}: ${item.reason}` };
    members.push(`${identifierLiteral(key)}: ${item.text}`);
  }
  return { ok: true, text: `#{${members.join(", ")}}`, value };
}

const ANY_LIST: ArrayTarget = { kind: "array", element: { kind: "any" } };
const ANY_RECORD: RecordTarget = { kind: "record", value: { kind: "any" } };

function anyLiteral(value: unknown, depth: number): Literal {
  if (value === null) return { ok: true, text: "null", value };
  if (typeof value === "boolean") return booleanLiteral(value);
  if (typeof value === "string") return stringLiteral(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, text: String(value), value } : { ok: false, reason: `${show(value)} is not a finite number` };
  }
  if (Array.isArray(value)) return arrayLiteral(value, ANY_LIST, depth, false);
  if (isPlainObject(value)) return recordLiteral(value, ANY_RECORD, depth, false);
  return { ok: false, reason: `${show(value)} has no TypeSpec form` };
}

/** A literal member of a union: the value it is, coerced the way its kind coerces (text `"5"` takes the number 5 only as text). */
function constantLiteral(value: unknown, target: ConstantTarget): Literal {
  const read =
    typeof target.value === "string"
      ? stringLiteral(value)
      : typeof target.value === "boolean"
        ? booleanLiteral(value)
        : numericLiteral(value, FLOAT64, false);
  if (read.ok && read.value === target.value) return { ok: true, text: target.text, value: target.value };
  return { ok: false, reason: `${show(value)} is not ${target.text}` };
}

/** Whether a member takes the value as it is, without coercion: text for text, a number for a number, `true` for `true`. */
function takesAsIs(value: unknown, member: LiteralTarget): boolean {
  switch (member.kind) {
    case "string":
    case "enum":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "number":
      return typeof value === "number";
    case "constant":
      return value === member.value;
    case "array":
      return Array.isArray(value);
    case "record":
      return isPlainObject(value);
    case "any":
      return true;
    case "union":
      return member.members.some((m) => takesAsIs(value, m));
  }
}

/**
 * A union takes the first member that takes the value. A member that takes it as it is comes before one that only coerces it, so text stays
 * text, a number stays a number, and a listed literal (`"a"`) is written as that literal.
 */
function unionLiteral(value: unknown, target: UnionTarget, depth: number, example: boolean): Literal {
  const members = [...target.members.filter((m) => takesAsIs(value, m)), ...target.members.filter((m) => !takesAsIs(value, m))];
  for (const member of members) {
    const item = literalFor(value, member, depth, example);
    if (item.ok) return item;
  }
  return { ok: false, reason: `${show(value)} is not a value of the union` };
}

/**
 * The TypeSpec literal of a stored value for a target type, or the reason it is withheld. A scalar's `value` is the number, boolean or
 * text it stands for once coerced; a list's and an object's is the coerced list or object. `example` is set for a documentation example,
 * a decorator argument, which is written in the form the compiler reads (see {@link integerLiteral}); a default is written as is.
 */
export function literalFor(value: unknown, target: LiteralTarget, depth = 1, example = false): Literal {
  if (depth > MAX_LITERAL_DEPTH) return { ok: false, reason: "nests too deeply to write" };
  switch (target.kind) {
    case "string":
      return stringLiteral(value);
    case "boolean":
      return booleanLiteral(value);
    case "integer":
    case "number":
      return numericLiteral(value, target, example);
    case "enum":
      return enumLiteral(value, target);
    case "array":
      return arrayLiteral(value, target, depth, example);
    case "record":
      return recordLiteral(value, target, depth, example);
    case "any":
      return anyLiteral(value, depth);
    case "constant":
      return constantLiteral(value, target);
    case "union":
      return unionLiteral(value, target, depth, example);
  }
}

/** What a Default Value input holding a text is stored as (see {@link defaultInput}). */
export type DefaultInput =
  | { status: "cleared" }
  | { status: "value"; value: string | number | boolean }
  | { status: "rejected"; text: string; reason: string };

/**
 * What a Default Value input holding `text` is stored as, for a field of logical type `typeId`: nothing for an empty input; the typed value for
 * a numeric or boolean type (a number, a boolean); the text otherwise; or, for a numeric or boolean type and for a date, time or duration type,
 * the text with the reason it does not fit the type (a date is written only as its constructor, see {@link constructorLiteral}). A type whose
 * literal depends on the field (an enum, a list, a map, an object, a union, a reference) takes the text, which is checked against the field's
 * members when it is written. The generator reads the same text the same way, so what is stored is what is written.
 */
export function defaultInput(text: string, typeId: string): DefaultInput {
  const target = scalarLiteralTarget(typeId);
  if (isClearedValue(text, target)) return { status: "cleared" };
  if (target === undefined) {
    if (LITERAL_FROM_FIELD.has(typeId) || typeId === "object") return { status: "value", value: text };
    const constructor = constructorLiteral(text, typeId);
    return constructor.ok
      ? { status: "value", value: constructor.value as string }
      : { status: "rejected", text, reason: constructor.reason };
  }
  if (target.kind === "string") return { status: "value", value: text };
  const literal = literalFor(text, target);
  return literal.ok
    ? { status: "value", value: literal.value as string | number | boolean }
    : { status: "rejected", text, reason: literal.reason };
}

/**
 * The literal of a stored value for a type with no literal target: the constructor of a date, time or duration type, written from the text it
 * holds (`utcDateTime.now()` on a utcDateTime field; `fromISO` re-quoted, so its escapes are the ones TypeSpec reads). Any other text, a text
 * TypeSpec cannot read, and every value of a type with no constructor (a reference, a custom name, bytes), is withheld with the reason.
 */
export function constructorLiteral(value: unknown, typeId: string): Literal {
  if (typeof value === "string") {
    const shape = constructorShape(value);
    if (shape?.scalar === typeId) {
      if (shape.method === "now" && shape.args === "") return { ok: true, text: `${typeId}.now()`, value: `${typeId}.now()` };
      if (shape.method === "fromISO") {
        const held = readQuotedText(shape.args);
        if (held === undefined) {
          return { ok: false, reason: `${show(value)} holds a text TypeSpec cannot read (an escape it does not define, a line break or a NUL character)` };
        }
        const text = `${typeId}.fromISO("${escapeString(held)}")`;
        return { ok: true, text, value: text };
      }
    }
  }
  const methods = Object.prototype.hasOwnProperty.call(STANDARD_CONSTRUCTORS, typeId) ? STANDARD_CONSTRUCTORS[typeId] : [];
  const forms = methods.map((method) => (method === "now" ? `${typeId}.now()` : `${typeId}.fromISO("…")`));
  if (forms.length === 0) return { ok: false, reason: `a ${typeId} field has no literal form in TypeSpec text` };
  return { ok: false, reason: `${show(value)} is not a ${typeId} value; TypeSpec writes one as ${forms.join(" or ")}` };
}

/**
 * The text a stored default shows in a Default Value input: the stored text, except a whole number past 2^53 on an integer type, which shows its
 * exact digits (String() gives the shortest text that reads back as the number, which past 2^53 is not the number the generator writes).
 */
export function storedDefaultText(value: unknown, typeId: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && scalarLiteralTarget(typeId)?.kind === "integer") {
    return BigInt(value).toString();
  }
  return String(value);
}

/** Logical types whose literal depends on what the generator knows about the field (an enum's members, a list's element, a union's members). */
const LITERAL_FROM_FIELD = new Set(["enum", "array", "map", "union", "reference"]);

/**
 * The literal the generator writes for a documentation example of a field of logical type `typeId`, for the Documentation panel to preview: the
 * same literal for a scalar or an object type, the constructor text for a date, time or duration type (see {@link constructorLiteral}), the reason
 * it is withheld for a type with no literal form, or undefined for a type whose literal depends on what the generator knows about the field:
 * those are not previewed.
 */
export function previewLiteral(value: unknown, typeId: string): Literal | undefined {
  if (typeId === "object") return literalFor(value, { kind: "record", value: { kind: "any" } }, 1, true);
  const target = scalarLiteralTarget(typeId);
  if (target) return literalFor(value, target, 1, true);
  if (LITERAL_FROM_FIELD.has(typeId)) return undefined;
  return constructorLiteral(value, typeId);
}
