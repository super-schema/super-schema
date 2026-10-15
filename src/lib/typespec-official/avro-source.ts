/**
 * avro-source.ts — projects the canonical TypeSpec source onto what the Avro emitter can publish as a VALID schema,
 * WITHOUT touching the canonical source every other target compiles (same idea as `protobuf-source.ts`).
 *
 * Why this exists: the canonical source keeps wire names, so an enum member can be `"in-progress"`, `"en US"` or `"1"`.
 * The Avro emitter (`@superschema/typespec-avro`, a separate repo) writes `symbols` from the member names as they are,
 * but an Avro enum symbol must match `[A-Za-z_][A-Za-z0-9_]*` — the AsyncAPI parser rejects the whole document
 * (`"0" must match pattern ^[A-Za-z_][A-Za-z0-9_]*$`). Avro field names are already sanitised by the emitter.
 *
 * What it does: rewrites every enum member (or string member value) that is not a valid Avro symbol to the symbol the
 * pipeline always produced for it (`in-progress` -> `in_progress`, `en US` -> `en_US`, `1` -> `_1`), and REPORTS it:
 *
 * - `renames`: wire value -> published symbol, surfaced as a warning (the rename is lossy: consumers must send the symbol);
 * - `collisions`: two values that become the same symbol (`a-b` / `a b`) — an error, never silently merged.
 *
 * A member that is already a valid symbol is untouched, keywords included (`model` is a fine Avro symbol). Members with
 * a numeric value (`A: 1`) cannot be projected — Avro carries no numeric enum values and the emitter would publish the
 * number as the symbol — so they are left as written and caught by the safety net ({@link findInvalidAvroSymbols}),
 * which fails the emission loudly, naming the enum. Pure functions, no I/O.
 */

import { enumMemberName, unescapeTypeSpecText } from "@/lib/compiler/typespec-identifiers";

/** What the Avro specification requires of a symbol (and of a field / record name). */
export const AVRO_SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface AvroSymbolRename {
  /** The TypeSpec enum (field-scoped enums are `<Entity>_<field>`). */
  enumName: string;
  from: string;
  to: string;
}

export interface AvroSymbolCollision {
  enumName: string;
  to: string;
  /** Every original value that became `to` (two or more). */
  from: string[];
}

export interface AvroProjection {
  source: string;
  renames: AvroSymbolRename[];
  collisions: AvroSymbolCollision[];
}

/** The symbol for a wire value: invalid characters become `_`, a leading digit gets a `_` prefix, nothing becomes `_`. */
export function toAvroSymbol(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/g, "_");
  if (safe === "") return "_";
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/** `[decorators] name [: "value"]`; the name is a bare identifier, a backticked identifier or a quoted string. */
const MEMBER =
  /^(\s*(?:@[\w.]+(?:\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))?\s*)*)(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)(\s*:\s*)?("(?:[^"\\]|\\.)*")?/;

/**
 * Index just past the string literal (`"…"`, `"""…"""`), backticked identifier or comment that starts at `i`; `i` itself
 * when none does. A `//` comment stops AT its line break (the break still separates members). Everything that scans
 * enum text goes through this, so a `{`, `}`, `,` or `//` inside a symbol, a `@doc("see {x}")` or a comment is never
 * mistaken for structure.
 */
function skipTrivia(text: string, i: number): number {
  const c = text[i];
  if (c === "/" && text[i + 1] === "/") {
    const newline = text.indexOf("\n", i);
    return newline < 0 ? text.length : newline;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (text.startsWith('"""', i)) {
    const end = text.indexOf('"""', i + 3);
    return end < 0 ? text.length : end + 3;
  }
  if (c === '"' || c === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, text.length);
  }
  return i;
}

/** Split an enum body into `[text, separator]` pairs, honouring strings, backticks, comments and parentheses. */
function splitMembers(body: string): Array<{ text: string; separator: string }> {
  const parts: Array<{ text: string; separator: string }> = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const next = skipTrivia(body, i);
    if (next !== i) {
      i = next;
      continue;
    }
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "," || c === ";" || c === "\n")) {
      parts.push({ text: body.slice(start, i), separator: c });
      start = i + 1;
    }
    i++;
  }
  parts.push({ text: body.slice(start), separator: "" });
  return parts;
}

/** Index of the `}` that closes the `{` at `open` (nested braces counted, strings and comments skipped), or -1. */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const next = skipTrivia(source, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i;
    i++;
  }
  return -1;
}

interface EnumBlock {
  name: string;
  /** Offsets of the text between the braces. */
  bodyStart: number;
  bodyEnd: number;
}

const ENUM_HEADER = /enum\s+(`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*)\s*\{/y;

/**
 * Every `enum Name { … }` declaration, wherever it is — top level, inside a `namespace X { … }` block, after a
 * decorator — found by a scan that skips strings and comments and counts nested braces (a regex over `[^{}]*` silently
 * skipped any enum whose body held a brace, which then reached the Avro emitter unprojected).
 */
function findEnumBlocks(source: string): EnumBlock[] {
  const blocks: EnumBlock[] = [];
  let i = 0;
  while (i < source.length) {
    const next = skipTrivia(source, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if (source.startsWith("enum", i) && !/[\w$.]/.test(source[i - 1] ?? " ")) {
      ENUM_HEADER.lastIndex = i;
      const header = ENUM_HEADER.exec(source);
      if (header) {
        const open = i + header[0].length - 1;
        const close = matchingBrace(source, open);
        if (close >= 0) {
          const raw = header[1];
          blocks.push({
            name: raw.startsWith("`") ? unescapeTypeSpecText(raw.slice(1, -1)) : raw,
            bodyStart: open + 1,
            bodyEnd: close,
          });
          i = close + 1;
          continue;
        }
      }
    }
    i++;
  }
  return blocks;
}

export function projectTypeSpecSourceForAvro(source: string): AvroProjection {
  const renames: AvroSymbolRename[] = [];
  const collisions: AvroSymbolCollision[] = [];

  let projected = "";
  let cursor = 0;
  for (const { name: enumName, bodyStart, bodyEnd } of findEnumBlocks(source)) {
    const body = source.slice(bodyStart, bodyEnd);
    const published = new Map<string, string[]>(); // published symbol -> original values
    let changed = false;
    const rewritten = splitMembers(body).map(({ text, separator }) => {
      const member = MEMBER.exec(text);
      if (!member) return text + separator;
      const [whole, prefix, nameToken, colon, valueLiteral] = member;
      if (colon !== undefined && valueLiteral === undefined) return text + separator; // a numeric value: left alone

      const name = nameToken.startsWith("`") || nameToken.startsWith('"') ? unescapeTypeSpecText(nameToken.slice(1, -1)) : nameToken;
      const wire = valueLiteral !== undefined ? unescapeTypeSpecText(valueLiteral.slice(1, -1)) : name;
      const symbol = AVRO_SYMBOL.test(wire) ? wire : toAvroSymbol(wire);
      published.set(symbol, [...(published.get(symbol) ?? []), wire]);
      if (symbol === wire) return text + separator;

      renames.push({ enumName, from: wire, to: symbol });
      changed = true;
      const rest = text.slice(whole.length);
      const replaced =
        valueLiteral !== undefined
          ? `${prefix}${nameToken}${colon}"${symbol}"`
          : `${prefix}${enumMemberName(symbol)}`;
      return replaced + rest + separator;
    });

    for (const [symbol, originals] of published) {
      const distinct = [...new Set(originals)];
      if (distinct.length > 1) collisions.push({ enumName, to: symbol, from: distinct });
    }
    projected += source.slice(cursor, bodyStart) + (changed ? rewritten.join("") : body);
    cursor = bodyEnd;
  }
  projected += source.slice(cursor);

  return { source: projected, renames, collisions };
}

/** The user-facing wording: renames are warnings (lossy but valid), collisions are errors. */
export function describeAvroProjection(projection: AvroProjection): { warnings: string[]; errors: string[] } {
  return {
    warnings: projection.renames.map(
      (r) =>
        `Avro enum symbol "${r.from}" of ${r.enumName} is published as "${r.to}" (an Avro symbol must match [A-Za-z_][A-Za-z0-9_]*); consumers must send "${r.to}"`
    ),
    errors: projection.collisions.map(
      (c) =>
        `Avro enum ${c.enumName}: the values ${c.from.map((v) => `"${v}"`).join(" and ")} would all be published as the symbol "${c.to}" — rename one of them`
    ),
  };
}

export interface InvalidAvroSymbol {
  /** The enum as the Avro emitter named it (the TypeSpec enum name, PascalCased). */
  enumName: string;
  symbol: string;
}

/**
 * The safety net: every `symbols` entry of every enum in an EMITTED Avro schema must be a valid symbol. The projection
 * fixes what it can; what it cannot (a member with a numeric value publishes `"1"`) must fail loudly, naming the enum,
 * instead of reaching the AsyncAPI parser as dozens of opaque errors.
 */
export function findInvalidAvroSymbols(schema: unknown): InvalidAvroSymbol[] {
  const invalid: InvalidAvroSymbol[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (record.type === "enum" && Array.isArray(record.symbols)) {
      const enumName = typeof record.name === "string" ? record.name : "(unnamed)";
      for (const symbol of record.symbols) {
        if (typeof symbol === "string" && AVRO_SYMBOL.test(symbol)) continue;
        const text = String(symbol);
        const key = `${enumName}\u0000${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          invalid.push({ enumName, symbol: text });
        }
      }
    }
    stack.push(...Object.values(record));
  }
  return invalid;
}

export function describeInvalidAvroSymbols(invalid: InvalidAvroSymbol[]): string[] {
  return invalid.map(({ enumName, symbol }) => {
    const hint = /^[0-9]+$/.test(symbol)
      ? "an enum member with a numeric value publishes that number, which Avro cannot carry — use named members without values"
      : "rename the member to a name that is a valid identifier";
    return `Avro enum ${enumName} has the symbol "${symbol}", which is not valid (an Avro symbol must match [A-Za-z_][A-Za-z0-9_]*) — ${hint}`;
  });
}
