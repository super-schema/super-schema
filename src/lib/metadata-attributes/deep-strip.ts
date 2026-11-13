/**
 * The defensive last pass of `internal`-scope metadata attributes (ruling R10): whatever the projections before it missed (a key nested
 * in another extension's value, a trait spec, an `items` extension, a stored document published before the key became internal), an
 * `internal` key never leaves in an emitted JSON / YAML document. The key is removed at ANY object depth, as a property name; values
 * (a `required` list naming it, a description mentioning it) are left alone.
 *
 * Pure. Byte-identical when nothing matched: the same reference (object) or the same file (string content) comes back.
 */

import { parseDocument, isMap, isSeq, type Node as YamlNode } from "yaml";

type Keys = ReadonlySet<string> | readonly string[] | undefined;

const toSet = (keys: Keys): ReadonlySet<string> | undefined => {
  if (!keys) return undefined;
  const set = keys instanceof Set ? keys : new Set(keys as readonly string[]);
  return set.size > 0 ? set : undefined;
};

function strip(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = strip(item, keys);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k)) {
      changed = true;
      continue;
    }
    const next = strip(v, keys);
    if (next !== v) changed = true;
    entries.push([k, next]);
  }
  if (!changed) return value;
  const out: Record<string, unknown> = {};
  // Own data properties only (`__proto__` included as a plain key): never through the prototype setter.
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/** `doc` without the `keys` at any object depth; the same reference when none is present (or there are no keys). */
export function deepStripInternal<T>(doc: T, keys: Keys): T {
  const set = toSet(keys);
  if (!set) return doc;
  return strip(doc, set) as T;
}

/** Removes the keys from a parsed YAML node in place; true when something was removed. */
function stripYamlNode(node: unknown, keys: ReadonlySet<string>): boolean {
  let changed = false;
  if (isMap(node)) {
    const kept = node.items.filter((pair) => {
      const key = (pair.key as { value?: unknown } | null)?.value ?? pair.key;
      return !(typeof key === "string" && keys.has(key));
    });
    if (kept.length !== node.items.length) {
      node.items = kept;
      changed = true;
    }
    for (const pair of node.items) if (stripYamlNode(pair.value as YamlNode, keys)) changed = true;
  } else if (isSeq(node)) {
    for (const item of node.items) if (stripYamlNode(item, keys)) changed = true;
  }
  return changed;
}

const JSON_FILE = /\.(json|avsc)$/i;
const YAML_FILE = /\.ya?ml$/i;

/** The indentation a JSON text was written with (what `JSON.stringify` gets back), from its first indented line. */
function jsonIndent(content: string): number | string {
  const m = /\n([ \t]+)\S/.exec(content);
  if (!m) return 0;
  return m[1].includes("\t") ? "\t" : m[1].length;
}

/**
 * `file` with the keys removed at any depth of its JSON (`.json`, `.avsc`) or YAML (`.yaml`, `.yml`) content. Any other file, a file
 * whose content mentions none of the keys, or one that does not parse, comes back as is (the same object). A changed JSON file is
 * re-serialized with its own indentation; a changed YAML file keeps its comments and layout (the parsed document is edited).
 */
export function deepStripInternalFromFile<F extends { path: string; content: string }>(file: F, keys: Keys): F {
  const set = toSet(keys);
  if (!set) return file;
  const isJson = JSON_FILE.test(file.path);
  const isYaml = !isJson && YAML_FILE.test(file.path);
  if (!isJson && !isYaml) return file;
  // A key can only be written escaped in JSON (`x-…`); otherwise a content that never mentions a key holds none of them.
  const mentioned = [...set].some((k) => file.content.includes(k)) || (isJson && file.content.includes("\\u"));
  if (!mentioned) return file;
  if (isJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch {
      return file;
    }
    const stripped = strip(parsed, set);
    if (stripped === parsed) return file;
    const trailing = file.content.endsWith("\n") ? "\n" : "";
    return { ...file, content: JSON.stringify(stripped, null, jsonIndent(file.content)) + trailing };
  }
  const doc = parseDocument(file.content);
  if (doc.errors.length > 0) return file;
  if (!stripYamlNode(doc.contents, set)) return file;
  return { ...file, content: doc.toString() };
}

/** Every file through {@link deepStripInternalFromFile}; the same array when none changed. */
export function deepStripInternalFromFiles<F extends { path: string; content: string }>(files: F[], keys: Keys): F[] {
  if (!toSet(keys)) return files;
  let changed = false;
  const out = files.map((f) => {
    const next = deepStripInternalFromFile(f, keys);
    if (next !== f) changed = true;
    return next;
  });
  return changed ? out : files;
}
