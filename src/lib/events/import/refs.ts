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
import { MAX_EXPANDED_NODES, MAX_NESTING_DEPTH } from "./limits";

/** The longest chain of `$ref` wrappers `deref` follows. */
const MAX_DEREF_HOPS = 64;

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
  /** Follows every ref in the whole document (unused sections included): the first external, missing, recursive or oversized one is the error. */
  check(): Result<void>;
  /** Pointers of every ref target followed so far. */
  readonly followed: ReadonlySet<string>;
}

type Expanded = { value: unknown; size: number };

class RefFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}

export function createRefResolver(root: unknown): RefResolver {
  const memo = new Map<string, Expanded>();
  const inProgress: string[] = [];
  const followed = new Set<string>();
  let used = 0;
  /** Where the walk is, as pointer segments: only turned into text when an error needs it. */
  let cursor: Array<string | number> = [];
  const here = (): string => (cursor.length === 0 ? "the document root" : `"${jsonPointer(...cursor)}"`);

  const fail = (code: string, message: string, extra: { ref?: string; suggestedFix?: string } = {}): never => {
    throw new RefFailure({ code, message, details: { pointer: jsonPointer(...cursor), ...(extra.ref !== undefined && { ref: extra.ref }) }, ...(extra.suggestedFix !== undefined && { suggestedFix: extra.suggestedFix }) });
  };

  function locate(ref: string): { pointer: string; segments: string[]; value: unknown } {
    const classified = classify(ref);
    if (classified.kind === "external") {
      return fail("EXTERNAL_REF", `The reference "${ref}" at ${here()} points outside the document. Only references inside the document (#/components/…) can be imported; external files and URLs are never fetched.`, {
        ref, suggestedFix: "Bundle the document first (for example with the AsyncAPI CLI: asyncapi bundle), or paste the referenced content into the file.",
      });
    }
    if (classified.kind === "anchor") {
      return fail("REF_NOT_FOUND", `The reference "${ref}" at ${here()} is not a JSON pointer; write references as #/components/…`, { ref });
    }
    const found = resolveLocalRef(root, localRef(...classified.segments));
    if (!found.found) {
      return fail("REF_NOT_FOUND", `The reference "${ref}" at ${here()} points to something that does not exist in the document.`, {
        ref, suggestedFix: "References are followed from the document root: write the full path (for example #/components/schemas/Name).",
      });
    }
    return { pointer: jsonPointer(...classified.segments), segments: classified.segments, value: found.value };
  }

  const charge = (size: number): void => {
    used += size;
    if (size > MAX_EXPANDED_NODES || used > MAX_EXPANDED_NODES) {
      fail("REF_TOO_LARGE", `The references in this document expand to more than ${MAX_EXPANDED_NODES.toLocaleString("en-US")} values (found at ${here()}); it was rejected as too large.`, {
        suggestedFix: "Reduce how often large definitions are referenced, or split the document.",
      });
    }
  };

  function follow(ref: string, depth: number): Expanded {
    const target = locate(ref);
    const hit = memo.get(target.pointer);
    if (hit) {
      charge(hit.size);
      return hit;
    }
    const open = inProgress.indexOf(target.pointer);
    if (open !== -1) {
      const loop = [...inProgress.slice(open), target.pointer].map((p) => `#${p}`).join(" → ");
      return fail("REF_CYCLE", `Recursive reference: ${loop} (found at ${here()}). A reference that leads back to itself cannot be imported.`, {
        ref, suggestedFix: "Remove the recursion, or replace the recursive part with a plain object schema.",
      });
    }
    inProgress.push(target.pointer);
    const saved = cursor;
    cursor = [...target.segments]; // errors inside the target name the target's own location
    let expanded: Expanded;
    try {
      expanded = expand(target.value, depth + 1);
    } finally {
      cursor = saved;
      inProgress.pop();
    }
    memo.set(target.pointer, expanded);
    followed.add(target.pointer);
    charge(expanded.size);
    return expanded;
  }

  function expand(node: unknown, depth: number): Expanded {
    if (typeof node !== "object" || node === null) return { value: node, size: 1 };
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
  function run<T>(body: () => T): Result<T> {
    try {
      return ok(body());
    } catch (e) {
      inProgress.length = 0;
      if (e instanceof RefFailure) return err(e.error);
      if (e instanceof RangeError) return err({ code: "REF_TOO_LARGE", message: "The document is nested too deeply to import." });
      throw e;
    }
  }

  return {
    followed,
    inline(value, at) {
      return run(() => {
        cursor = pointerSegments(at);
        return expand(value, 0).value;
      });
    },
    check() {
      return run(() => {
        cursor = [];
        expand(root, 0);
      });
    },
    deref(value, at) {
      return run(() => {
        cursor = pointerSegments(at);
        let current = value;
        let pointer = at;
        const seen: string[] = [];
        while (isRef(current)) {
          const target = locate(current.$ref);
          if (seen.includes(target.pointer)) {
            fail("REF_CYCLE", `Recursive reference: ${[...seen.slice(seen.indexOf(target.pointer)), target.pointer].map((p) => `#${p}`).join(" → ")} (found at ${here()}).`, { ref: current.$ref });
          }
          if (seen.length >= MAX_DEREF_HOPS) fail("REF_TOO_LARGE", `A chain of more than ${MAX_DEREF_HOPS} references starting at ${here()} cannot be imported.`);
          seen.push(target.pointer);
          followed.add(target.pointer);
          current = target.value;
          pointer = target.pointer;
          cursor = [...target.segments];
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
