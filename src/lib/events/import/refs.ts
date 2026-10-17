// src/lib/events/import/refs.ts
// Local `$ref` resolution for the AsyncAPI importer. Pure — client-safe.
//
// An imported file may only refer to itself (`#/components/...`). External references (URLs, files, relative paths) are rejected, never
// fetched; a reference that leads back to itself is an error; and every expansion is bounded, so neither a loop nor a "billion laughs"
// chain of references can exhaust time, memory or the stack.
//
// The importer needs two views of the same file: the IDENTITY of components that the event document keeps by key (messages, traits,
// security schemes — so `$ref: '#/components/messages/X'` stays key `X`), and the CONTENT of everything the document stores inline
// (schemas, tags, bindings, …). So the resolver offers both: `deref` follows only the wrappers around a value (its own nested refs stay as
// written), `inline` replaces every ref in a value by its target.
import { err, ok, type Result, type ServiceError } from "@/types/result";
import { jsonPointer, localRef, resolveLocalRef, unescapePointerSegment } from "@/lib/event-specs/json-pointer";
import { setOwn } from "@/lib/event-specs/own-property";
import { CHARS_PER_NODE, MAX_EXPANDED_NODES, MAX_NESTING_DEPTH, MAX_REF_LENGTH } from "./limits";
import { boundChain, boundPointer, boundText, CHAIN_ENTRY_LENGTH, MAX_CHAIN_ENTRIES } from "./bound";

/** The longest chain of `$ref` wrappers `deref` follows (a real file has one or two; each hop is paid again for every use). */
const MAX_DEREF_HOPS = 16;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ $ref: "…" }`: an object with a string `$ref` (a property NAMED `$ref` holds a schema object, never a string). */
export function isRef(value: unknown): value is { $ref: string } {
  return isPlainObject(value) && Object.hasOwn(value, "$ref") && typeof value.$ref === "string";
}

type Classified = { kind: "local"; segments: string[] } | { kind: "external" } | { kind: "anchor" };

const safeDecode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** A ref string as a decoded JSON pointer (URI-fragment form: percent-decoding first, then `~1` / `~0`). */
function classify(ref: string): Classified {
  if (!ref.startsWith("#")) return { kind: "external" };
  const rest = ref.slice(1);
  if (rest === "") return { kind: "local", segments: [] };
  if (!rest.startsWith("/")) return { kind: "anchor" };
  return { kind: "local", segments: rest.slice(1).split("/").map((segment) => unescapePointerSegment(safeDecode(segment))) };
}

/** The decoded path segments (`["components", "messages", "X"]`) a local ref points at, or `null` when `value` is not a local ref. Resolves nothing. */
export function refTargetSegments(value: unknown): string[] | null {
  if (!isRef(value)) return null;
  const classified = classify(value.$ref);
  return classified.kind === "local" ? classified.segments : null;
}

/** The canonical pointer (`/components/messages/X`) a local ref points at, or `null` when `value` is not a local ref. Resolves nothing. */
export function refTargetPointer(value: unknown): string | null {
  const segments = refTargetSegments(value);
  return segments === null ? null : jsonPointer(...segments);
}

const pointerSegments = (pointer: string): string[] => (pointer === "" ? [] : pointer.slice(1).split("/").map(unescapePointerSegment));

export interface RefResolver {
  /**
   * Follows a chain of `$ref` wrappers and returns what it ends at, exactly as written (refs INSIDE it are untouched), with the pointer of
   * where it is defined. A value that is not a ref comes back as itself at `at`.
   */
  deref(value: unknown, at: string): Result<{ value: unknown; pointer: string }>;
  /** A copy of `value` with every ref inside it replaced by its target. Targets are shared between uses, so treat the result as read-only. */
  inline(value: unknown, at: string): Result<unknown>;
  /**
   * Like `inline` for SCHEMA content (a message payload or headers schema): a schema that refers to itself is not an error. It comes back as
   * `{ recursive }` — the chain of references that closes the loop — so the caller can degrade that one schema instead of the whole import.
   * External, missing and oversized references are still errors.
   */
  inlineSchema(value: unknown, at: string): Result<{ value: unknown } | { recursive: string[] }>;
  /**
   * Follows every ref in the whole document (unused sections included): the first external, missing or oversized one is the error.
   * A recursive one is too, unless `tolerateCycles`: then the loop is only noted, and the strict readers (`inline`, `deref`) refuse it later
   * if what they read leads into it. That is what lets a recursive SCHEMA (read with `inlineSchema`) or an unused one through, while a
   * cycle through bindings, traits, messages or a chain of wrappers still fails the import.
   */
  check(options?: { tolerateCycles?: boolean }): Result<void>;
  /** Charges `nodes` values to the expansion budget (see `MAX_EXPANDED_NODES`): for work done on a shared target outside `inline`, such as writing it out as text. */
  chargeNodes(nodes: number, at: string): Result<void>;
  /** Pointers of every ref target followed so far. */
  readonly followed: ReadonlySet<string>;
  /**
   * Who refers to what, found by `check` / `deref` / `inline`: for each OWNER (the component entry `/components/<section>/<key>` the ref is
   * written in, or "" for anything outside `components`) the component entries it refers to. A component that only refers to itself, or
   * that only unused components refer to, is not reachable from the document: that is what "nothing refers to it" means.
   */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A ref that resolved: where it points (`pointer`, `segments`), what is there, and the component entry it lies in (`entry`). */
interface Located { pointer: string; segments: string[]; value: unknown; entry: string }

/** `cycle`: the expansion ran into a reference loop (only recorded when cycles are tolerated); its `value` has holes where the loop closes. */
type Expanded = { value: unknown; size: number; cycle?: string[] };

class RefFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}

export function createRefResolver(root: unknown): RefResolver {
  const memo = new Map<string, Expanded>();
  const inProgress: string[] = [];
  const followed = new Set<string>();
  const edges = new Map<string, Set<string>>();
  let used = 0;
  /** True while a call tolerates cycles: a loop is noted (`hits`, `lastLoop`) and cut instead of thrown. */
  let tolerate = false;
  let hits = 0;
  let lastLoop: string[] = [];
  /** Where the walk is, as pointer segments: only turned into text when an error needs it. */
  let cursor: Array<string | number> = [];
  const here = (): string => (cursor.length === 0 ? "the document root" : `"${boundText(jsonPointer(...cursor), 120)}"`);

  const entryOf = (segments: ReadonlyArray<string | number>): string => (segments[0] === "components" && segments.length >= 3 ? jsonPointer(...segments.slice(0, 3)) : jsonPointer(...segments));
  /** Records that the ref being read (written at the cursor) points at the component entry `targetEntry`. */
  const noteEdge = (targetEntry: string): void => {
    const owner = cursor[0] === "components" && cursor.length >= 3 ? entryOf(cursor) : "";
    const targets = edges.get(owner) ?? new Set<string>();
    targets.add(targetEntry);
    edges.set(owner, targets);
  };
  /**
   * What a ref string points at, by the ref as written. A file uses a handful of distinct refs thousands of times (every message points at the same
   * schema), and each one used to be split, decoded and resolved again at every use; a ref is at most MAX_REF_LENGTH long, so the cache is as small as the file.
   */
  const located = new Map<string, Located>();

  const fail = (code: string, message: string, extra: { ref?: string; suggestedFix?: string } = {}): never => {
    throw new RefFailure({ code, message, details: { pointer: boundPointer(jsonPointer(...cursor)), ...(extra.ref !== undefined && { ref: boundPointer(extra.ref) }) }, ...(extra.suggestedFix !== undefined && { suggestedFix: extra.suggestedFix }) });
  };

  function locate(ref: string): Located {
    const known = located.get(ref);
    if (known) {
      noteEdge(known.entry);
      return known;
    }
    // Every use of a reference is split, decoded and resolved again, so the work grows with its length: refuse a long one before touching it.
    if (ref.length > MAX_REF_LENGTH) {
      return fail("REF_TOO_LARGE", `A reference is longer than ${MAX_REF_LENGTH.toLocaleString("en-US")} characters (${ref.length.toLocaleString("en-US")}, starting "${boundText(ref, 60)}") at ${here()}; references that long are not paths into the document, so it was rejected.`, {
        ref, suggestedFix: "Give what is referenced shorter names, and keep the path to it short.",
      });
    }
    const classified = classify(ref);
    if (classified.kind === "external") {
      return fail("EXTERNAL_REF", `The reference "${boundText(ref, 120)}" at ${here()} points outside the document. Only references inside the document (#/components/…) can be imported; external files and URLs are never fetched.`, {
        ref, suggestedFix: "Bundle the document first (for example with the AsyncAPI CLI: asyncapi bundle), or paste the referenced content into the file.",
      });
    }
    if (classified.kind === "anchor") {
      return fail("REF_NOT_FOUND", `The reference "${boundText(ref, 120)}" at ${here()} is not a JSON pointer; write references as #/components/…`, { ref });
    }
    const found = resolveLocalRef(root, localRef(...classified.segments));
    if (!found.found) {
      return fail("REF_NOT_FOUND", `The reference "${boundText(ref, 120)}" at ${here()} points to something that does not exist in the document.`, {
        ref, suggestedFix: "References are followed from the document root: write the full path (for example #/components/schemas/Name).",
      });
    }
    const result: Located = { pointer: jsonPointer(...classified.segments), segments: classified.segments, value: found.value, entry: entryOf(classified.segments) };
    located.set(ref, result);
    noteEdge(result.entry);
    return result;
  }

  const charge = (size: number): void => {
    used += size;
    if (size > MAX_EXPANDED_NODES || used > MAX_EXPANDED_NODES) {
      fail("REF_TOO_LARGE", `The references in this document expand to more than ${MAX_EXPANDED_NODES.toLocaleString("en-US")} values (found at ${here()}); it was rejected as too large.`, {
        suggestedFix: "Reduce how often large definitions are referenced, or split the document.",
      });
    }
  };

  /** A reference loop: an error, or (tolerated) noted and cut with a hole where the loop closes. */
  function loopFound(loop: string[], ref: string): Expanded {
    if (!tolerate) {
      return fail("REF_CYCLE", `Recursive reference: ${boundChain(loop, MAX_CHAIN_ENTRIES, CHAIN_ENTRY_LENGTH)} (found at ${here()}). A reference that leads back to itself cannot be imported.`, {
        ref, suggestedFix: "Remove the recursion, or replace the recursive part with a plain object schema.",
      });
    }
    hits += 1;
    lastLoop = loop;
    return { value: undefined, size: 1, cycle: loop };
  }

  function follow(ref: string, depth: number): Expanded {
    const target = locate(ref);
    const hit = memo.get(target.pointer);
    if (hit) {
      if (hit.cycle) return loopFound(hit.cycle, ref); // an expansion that ran into a loop is never reused as if it were whole
      charge(hit.size);
      return hit;
    }
    const open = inProgress.indexOf(target.pointer);
    if (open !== -1) return loopFound([...inProgress.slice(open), target.pointer].map((p) => `#${p}`), ref);
    inProgress.push(target.pointer);
    const saved = cursor;
    const hitsBefore = hits;
    cursor = [...target.segments]; // errors inside the target name the target's own location
    let expanded: Expanded;
    try {
      expanded = expand(target.value, depth + 1);
    } finally {
      cursor = saved;
      inProgress.pop();
    }
    if (hits > hitsBefore) expanded = { ...expanded, cycle: lastLoop };
    memo.set(target.pointer, expanded);
    followed.add(target.pointer);
    charge(expanded.size);
    return expanded;
  }

  function expand(node: unknown, depth: number): Expanded {
    // a string costs one value plus one per CHARS_PER_NODE characters: a shared 500 KB string used by thousands of messages is not "1 value" each time
    if (typeof node !== "object" || node === null) return { value: node, size: typeof node === "string" ? 1 + Math.floor(node.length / CHARS_PER_NODE) : 1 };
    if (depth > MAX_NESTING_DEPTH) {
      return fail("REF_TOO_LARGE", `The document is nested (references included) more than ${MAX_NESTING_DEPTH} levels deep at ${here()}; it was rejected as too deep.`);
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      let size = 1;
      for (let i = 0; i < node.length; i += 1) {
        cursor.push(i);
        const child = expand(node[i], depth + 1);
        cursor.pop();
        out.push(child.value);
        size += child.size;
      }
      return { value: out, size };
    }
    const record = node as Record<string, unknown>;
    if (isRef(record)) {
      const written: Record<string, unknown> = record;
      const target = follow(record.$ref, depth + 1);
      const siblings = Object.keys(written).filter((key) => key !== "$ref");
      if (siblings.length === 0 || !isPlainObject(target.value)) return target;
      // JSON Schema 2020-12 allows keywords next to a $ref: they refine the target
      const merged: Record<string, unknown> = {};
      for (const key of Object.keys(target.value)) setOwn(merged, key, target.value[key]);
      let size = target.size;
      for (const key of siblings) {
        cursor.push(key);
        const child = expand(written[key], depth + 1);
        cursor.pop();
        setOwn(merged, key, child.value);
        size += child.size;
      }
      return { value: merged, size };
    }
    const out: Record<string, unknown> = {};
    let size = 1;
    for (const key of Object.keys(record)) {
      cursor.push(key);
      const child = expand(record[key], depth + 1);
      cursor.pop();
      setOwn(out, key, child.value);
      size += child.size;
    }
    return { value: out, size };
  }

  /** Runs `body`; a `RefFailure` (or a stack overflow nothing else caught) becomes the error, anything else is a bug and propagates. */
  function run<T>(body: () => T, tolerateCycles = false): Result<T> {
    tolerate = tolerateCycles;
    try {
      return ok(body());
    } catch (e) {
      inProgress.length = 0;
      if (e instanceof RefFailure) return err(e.error);
      if (e instanceof RangeError) return err({ code: "REF_TOO_LARGE", message: "The document is nested too deeply to import." });
      throw e;
    } finally {
      tolerate = false;
    }
  }

  return {
    followed,
    edges,
    chargeNodes(nodes, at) {
      return run(() => {
        cursor = pointerSegments(at);
        charge(nodes);
      });
    },
    inline(value, at) {
      return run(() => {
        cursor = pointerSegments(at);
        return expand(value, 0).value;
      });
    },
    inlineSchema(value, at) {
      return run(() => {
        cursor = pointerSegments(at);
        const hitsBefore = hits;
        const expanded = expand(value, 0);
        return hits > hitsBefore ? { recursive: lastLoop } : { value: expanded.value };
      }, true);
    },
    check(options) {
      return run(() => {
        cursor = [];
        expand(root, 0);
      }, options?.tolerateCycles === true);
    },
    deref(value, at) {
      return run(() => {
        cursor = pointerSegments(at);
        let current = value;
        let pointer = at;
        const seen: string[] = [];
        const start = pointerSegments(at); // where the chain began: the hop cap names this place, not the hop it stopped at
        while (isRef(current)) {
          const target = locate(current.$ref);
          if (seen.includes(target.pointer)) {
            fail("REF_CYCLE", `Recursive reference: ${boundChain([...seen.slice(seen.indexOf(target.pointer)), target.pointer].map((p) => `#${p}`), MAX_CHAIN_ENTRIES, CHAIN_ENTRY_LENGTH)} (found at ${here()}).`, { ref: current.$ref });
          }
          if (seen.length >= MAX_DEREF_HOPS) {
            cursor = start;
            fail("REF_TOO_LARGE", `A chain of more than ${MAX_DEREF_HOPS} references starting at ${here()} cannot be imported.`);
          }
          seen.push(target.pointer);
          followed.add(target.pointer);
          current = target.value;
          pointer = target.pointer;
          cursor = target.segments; // deref only reads the cursor, so the cached segments are shared, not copied
        }
        return { value: current, pointer };
      });
    },
  };
}

/** The whole document with every local `$ref` replaced by its target (see `createRefResolver`). Component identity is lost — use the resolver to keep it. */
export function resolveLocalRefs(raw: unknown): Result<unknown> {
  return createRefResolver(raw).inline(raw, "");
}
