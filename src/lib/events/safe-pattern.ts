// src/lib/events/safe-pattern.ts
// Which regular expressions of a tenant's JSON Schema may reach the BROWSER. The editor checks an example's strings against the pinned
// entity's schema with `json-schema-library`, which runs `new RegExp(pattern, "u")` on them, and a JavaScript regex that backtracks
// cannot be interrupted: a `pattern` such as `^(a+)+$` freezes the tab of whoever opens the message. We cannot put a time limit on it, so
// only a pattern that is LINEAR BY CONSTRUCTION is handed over (`isLinearSafePattern`), and `sanitizeSchemaPatterns` removes every other
// one from the schema that is sent. That only loses an advisory warning in the editor: the pattern stays in the entity and in the
// emitted AsyncAPI document. Pure and client-safe; it never throws and never runs a pattern (a pattern is only ever COMPILED, never matched).
//
// Why these rules make a pattern safe (a backtracking engine explores, for a pattern without a repeated group, at most one path per
// combination of its choices, and the choices are the alternatives of a group and the counts a quantifier allows):
//   - anchored at both ends, so there is one starting point, not one per character of the string;
//   - no quantified group, no back reference, no lookaround: nothing is repeated that contains a choice, nothing re-reads the string;
//   - at most ONE unbounded quantifier (`*`, `+`, `{n,}`): its choices grow with the string, so there may be only one of them;
//   - the choices of everything else multiply to at most MAX_BRANCHING (`a?` is 2, `a{2,5}` is 4, a group of three alternatives is 3):
//     `^a?a?a?a?...aaaa$` and `^(a|a)(a|a)(a|a)...$` have no quantified group and one unbounded quantifier at most, and still take 2^n steps.
// So the work is at most (the length of the string + 1) x MAX_BRANCHING paths. This is deliberately conservative: when the tokenizer
// cannot read something, the answer is "not safe".
import { SCHEMA_MAP_KEYWORDS } from "@/lib/event-specs/json-schema-keywords";
import { setOwn } from "@/lib/event-specs/own-property";
import type { JsonObject, JsonValue } from "@/lib/event-specs/types";

/** The longest pattern that may be handed to the browser. */
export const MAX_SAFE_PATTERN_LENGTH = 200;
/** The most paths the choices of a pattern (alternatives of its groups, counts of its bounded quantifiers) may multiply to. */
const MAX_BRANCHING = 1_000;

/** What the token before the current one was: a quantifier may only follow an `atom` (`start`, `bar`, `open`, an assertion and a group are not). */
type Previous = "start" | "atom" | "quantified" | "open" | "close" | "bar" | "assertion" | "end";

const NAMED_GROUP = /\(\?<[A-Za-z_][A-Za-z0-9_]*>/y;
const BRACES = /\{(\d+)(?:(,)(\d*))?\}/y;

/** The index after the escape that starts at `at` (a backslash), or -1 for one that is not read: a back reference, `\k<name>`, a malformed `\p{...}`. */
function afterEscape(pattern: string, at: number): number {
  const kind = pattern[at + 1];
  if (kind === undefined || (kind >= "1" && kind <= "9") || kind === "k") return -1;
  if (kind === "p" || kind === "P" || (kind === "u" && pattern[at + 2] === "{")) {
    const close = pattern[at + 2] === "{" ? pattern.indexOf("}", at + 3) : -1;
    return close === -1 ? -1 : close + 1;
  }
  return at + 2;
}

/** The index after the character class that starts at `at`, or -1 for one that is not read (unterminated, or holding a `[`). */
function afterClass(pattern: string, at: number): number {
  let i = at + 1;
  if (pattern[i] === "^") i += 1;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "]") return i + 1;
    if (c === "[") return -1;
    if (c === "\\") {
      i = afterEscape(pattern, i);
      if (i === -1) return -1;
    } else i += 1;
  }
  return -1;
}

/**
 * Whether `pattern` (a JSON Schema `pattern`, read with the `u` flag) is linear by construction: at most 200 characters, `^` first and an
 * unescaped `$` last (outside any class), no back reference, no lookaround, no quantified group, at most one unbounded quantifier,
 * choices that multiply to at most MAX_BRANCHING, no top-level `|`, nothing the tokenizer cannot read, and the `u` flag compiles it.
 */
export function isLinearSafePattern(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length > MAX_SAFE_PATTERN_LENGTH || pattern[0] !== "^") return false;
  let previous: Previous = "start";
  let unbounded = 0;
  let branching = 1;
  /** One entry per open group: how many alternatives it has so far. */
  const alternatives: number[] = [];

  for (let i = 1; i < pattern.length; ) {
    const c = pattern[i];
    if (c === "\\") {
      const next = afterEscape(pattern, i);
      if (next === -1) return false;
      previous = pattern[i + 1] === "b" || pattern[i + 1] === "B" ? "assertion" : "atom";
      i = next;
    } else if (c === "[") {
      const next = afterClass(pattern, i);
      if (next === -1) return false;
      previous = "atom";
      i = next;
    } else if (c === "(") {
      let next = i + 1;
      if (pattern[i + 1] === "?") {
        NAMED_GROUP.lastIndex = i;
        const named = NAMED_GROUP.exec(pattern);
        if (pattern[i + 2] === ":") next = i + 3; // (?:...)
        else if (named !== null) next = i + named[0].length; // (?<name>...) (never `(?<=` or `(?<!`, which have no name)
        else return false; // a lookahead, a lookbehind, a modifier
      }
      alternatives.push(1);
      previous = "open";
      i = next;
    } else if (c === ")") {
      const count = alternatives.pop();
      if (count === undefined) return false;
      branching *= count;
      if (branching > MAX_BRANCHING) return false;
      previous = "close";
      i += 1;
    } else if (c === "|") {
      if (alternatives.length === 0) return false; // the branches of a top-level alternation would not each be anchored
      alternatives[alternatives.length - 1] += 1;
      previous = "bar";
      i += 1;
    } else if (c === "*" || c === "+" || c === "?" || c === "{") {
      if (previous !== "atom") return false; // a quantified group, or nothing to repeat
      let choices = 1;
      if (c === "{") {
        BRACES.lastIndex = i;
        const braces = BRACES.exec(pattern);
        if (braces === null) return false;
        if (braces[2] !== undefined) {
          if (braces[3] === "") unbounded += 1;
          else {
            const span = Number(braces[3]) - Number(braces[1]) + 1;
            if (!(span >= 1)) return false;
            choices = span;
          }
        }
        i += braces[0].length;
      } else {
        if (c === "?") choices = 2;
        else unbounded += 1;
        i += 1;
      }
      if (pattern[i] === "?") i += 1; // lazy: the same quantifier
      branching *= choices;
      if (unbounded > 1 || branching > MAX_BRANCHING) return false;
      previous = "quantified";
    } else if (c === "$") {
      previous = alternatives.length === 0 ? "end" : "assertion";
      i += 1;
    } else if (c === "^") {
      previous = "assertion";
      i += 1;
    } else if (c === "]" || c === "}") {
      return false; // a lone bracket is a syntax error with the `u` flag
    } else {
      previous = "atom"; // `.` or a literal character
      i += 1;
    }
  }
  if (alternatives.length !== 0 || previous !== "end") return false;
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/** The keywords whose value is data, not a schema: copied as they are (`oversizedKeyword` of the example generator reads the same list). */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "example", "examples"]);
/** The keywords whose object has NAMES as keys (a property may be called `pattern`), `dependencies` besides the ones the other walkers share. */
const NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set([...SCHEMA_MAP_KEYWORDS, "dependencies"]);

/** How an object is read: a schema-like `node` (its `pattern` is judged), a map of `names` to nodes, `patterns` (like names, but the names are regexes), or a list. */
type Role = "node" | "names" | "patterns" | "list";
interface Task {
  role: Role;
  source: JsonObject | JsonValue[];
  target: JsonObject | JsonValue[];
}

/**
 * A COPY of `schema` in which every `pattern` that is not a string passing `isLinearSafePattern` is removed, and so is every
 * `patternProperties` entry whose key does not pass (with the schema under it). It looks at every object of the schema except the data
 * keywords (`const`, `enum`, `default`, `example`, `examples`, copied as they are) and the names of a map (`properties`, `definitions`,
 * `$defs`, `dependencies`, ... may hold a property called `pattern`), so a pattern under an unknown or `x-` keyword that a `$ref`
 * points at is removed too. Iterative, one visit per object (a shared sub-object is copied once and shared again; a cycle is cut by
 * the same memo), so it costs the size of the schema. The input is never touched.
 */
export function sanitizeSchemaPatterns(schema: JsonObject): JsonObject {
  const memo: Record<Role, Map<object, JsonObject | JsonValue[]>> = { node: new Map(), names: new Map(), patterns: new Map(), list: new Map() };
  const verdicts = new Map<string, boolean>();
  const safe = (pattern: string): boolean => {
    if (pattern.length > MAX_SAFE_PATTERN_LENGTH) return false;
    let verdict = verdicts.get(pattern);
    if (verdict === undefined) {
      verdict = isLinearSafePattern(pattern);
      verdicts.set(pattern, verdict);
    }
    return verdict;
  };
  const stack: Task[] = [];

  /** The copy of `value`: a primitive as it is; an object or list as an empty shell that the loop below fills. */
  function enter(role: Role, value: JsonValue): JsonValue {
    if (typeof value !== "object" || value === null) return value;
    const kind: Role = Array.isArray(value) ? "list" : role;
    const known = memo[kind].get(value);
    if (known !== undefined) return known;
    const target: JsonObject | JsonValue[] = Array.isArray(value) ? [] : {};
    memo[kind].set(value, target);
    stack.push({ role: kind, source: value, target });
    return target;
  }

  const root = enter("node", schema) as JsonObject;
  for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
    const { role, source, target } = task;
    if (Array.isArray(source)) {
      for (const item of source) (target as JsonValue[]).push(enter("node", item));
      continue;
    }
    const into = target as JsonObject;
    for (const [key, value] of Object.entries(source)) {
      if (role === "names") setOwn(into, key, enter("node", value));
      else if (role === "patterns") {
        if (safe(key)) setOwn(into, key, enter("node", value));
      } else if (key === "pattern") {
        if (typeof value === "string" && safe(value)) setOwn(into, key, value);
      } else if (DATA_KEYWORDS.has(key)) setOwn(into, key, structuredClone(value));
      else setOwn(into, key, enter(key === "patternProperties" ? "patterns" : NAME_MAP_KEYWORDS.has(key) ? "names" : "node", value));
    }
  }
  return root;
}
