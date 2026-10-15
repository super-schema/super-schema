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
 * a numeric value (`A: 1`) are left as written: Avro carries no numeric enum values. Pure functions, no I/O.
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

const ENUM_BLOCK = /^([ \t]*)enum[ \t]+([A-Za-z_$][\w$]*)[ \t]*\{([^{}]*)\}/gm;

/** `[decorators] name [: "value"]`; the name is a bare identifier, a backticked identifier or a quoted string. */
const MEMBER =
  /^(\s*(?:@[\w.]+(?:\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))?\s*)*)(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)(\s*:\s*)?("(?:[^"\\]|\\.)*")?/;

/** Split an enum body into `[text, separator]` pairs, honouring strings, backticks, comments and parentheses. */
function splitMembers(body: string): Array<{ text: string; separator: string }> {
  const parts: Array<{ text: string; separator: string }> = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end < 0 ? body.length : end + 2;
      continue;
    }
    if (c === '"' || c === "`") {
      i++;
      while (i < body.length && body[i] !== c) i += body[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
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

export function projectTypeSpecSourceForAvro(source: string): AvroProjection {
  const renames: AvroSymbolRename[] = [];
  const collisions: AvroSymbolCollision[] = [];

  const projected = source.replace(ENUM_BLOCK, (block, indent: string, enumName: string, body: string) => {
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
    return changed ? `${indent}enum ${enumName} {${rewritten.join("")}}` : block;
  });

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
