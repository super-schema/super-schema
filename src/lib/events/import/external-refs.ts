// src/lib/events/import/external-refs.ts
// Pure — client-safe. An AsyncAPI document that `$ref`s sibling files (`json/login_event_schema.json`, `../common/x.json#/definitions/y`) cannot be
// imported as one text: the importer refuses an external reference. This step folds the sibling files the caller provides INTO the document, as
// `components/schemas` entries, and rewrites each external reference to a local one; what cannot be loaded (no such file provided, a URL, a
// fragment that is not there) is replaced by an empty schema and reported, never fatal.
import { isBag } from "./message-index";
import { boundText } from "./bound";
import { pascalName } from "./payloads";
import type { ImportWarning } from "./types";

/** Hard limits: a hostile bundle must not make this step expensive. */
export const MAX_EXTERNAL_FILES = 100;
const MAX_REF_DEPTH = 64;

/** `a/b/../c.json` -> `a/c.json`; `./x` -> `x`; a path that climbs out of the root keeps its `..` (it is looked up as written). */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const isUrl = (ref: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(ref);

export interface InlineResult { document: Record<string, unknown>; warnings: ImportWarning[]; inlined: string[] }

/**
 * Returns a copy of `root` in which every external `$ref` is local. `files` maps a path (relative to the root document's directory, `/`
 * separated, e.g. `json/headers.json`) to that file's text (JSON; YAML is accepted when `parse` is given). Never throws.
 */
export function inlineExternalRefs(root: Record<string, unknown>, files: Readonly<Record<string, string>>, parse: (text: string) => unknown = JSON.parse): InlineResult {
  const warnings: ImportWarning[] = [];
  const known = new Map<string, string>(Object.entries(files).map(([path, text]) => [normalizePath(path), text]));
  const keyOfPath = new Map<string, string>();
  const registered: Record<string, unknown> = {};
  const usedKeys = new Set<string>(Object.keys(isBag(root.components) && isBag((root.components as Record<string, unknown>).schemas) ? ((root.components as Record<string, unknown>).schemas as Record<string, unknown>) : {}));

  const warn = (pointer: string, message: string) => warnings.push({ pointer: boundText(pointer, 200), code: "DROPPED_CONSTRUCT", message });

  const keyFor = (path: string): string => {
    const base = pascalName(path.replace(/\.[A-Za-z0-9]+$/, "").split("/").slice(-2).join(" "));
    let key = base;
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}${n}`;
    usedKeys.add(key);
    return key;
  };

  /** The local ref an external one becomes, or `null` (reported, caller substitutes an empty schema). */
  function localize(ref: string, dir: string, pointer: string, depth: number): string | null {
    if (isUrl(ref)) {
      warn(pointer, `The reference "${boundText(ref, 160)}" points at a URL; it cannot be fetched during an import, so it was replaced by an empty schema.`);
      return null;
    }
    const hash = ref.indexOf("#");
    const file = hash === -1 ? ref : ref.slice(0, hash);
    const fragment = hash === -1 ? "" : ref.slice(hash + 1);
    const path = normalizePath(dir === "" ? file : `${dir}/${file}`);
    let key = keyOfPath.get(path);
    if (key === undefined) {
      const text = known.get(path);
      if (text === undefined) {
        warn(pointer, `The referenced file "${boundText(path, 160)}" was not provided (it is not in the repository folder that was imported), so the reference was replaced by an empty schema.`);
        return null;
      }
      if (keyOfPath.size >= MAX_EXTERNAL_FILES || depth > MAX_REF_DEPTH) {
        warn(pointer, `Too many referenced files (the limit is ${MAX_EXTERNAL_FILES}); "${boundText(path, 160)}" was replaced by an empty schema.`);
        return null;
      }
      let parsed: unknown;
      try { parsed = parse(text); } catch {
        warn(pointer, `The referenced file "${boundText(path, 160)}" is not valid JSON/YAML, so the reference was replaced by an empty schema.`);
        return null;
      }
      if (!isBag(parsed)) {
        warn(pointer, `The referenced file "${boundText(path, 160)}" is not a schema object, so the reference was replaced by an empty schema.`);
        return null;
      }
      key = keyFor(path);
      keyOfPath.set(path, key);
      registered[key] = null; // reserve before walking: a file that refers back to itself or to an earlier file ends here
      registered[key] = walk(parsed, dirname(path), `#/components/schemas/${key}`, `/components/schemas/${key}`, depth + 1);
    }
    return `#/components/schemas/${key}${fragment}`;
  }

  /** `localBase` is where THIS file now lives in the document: its own `#/...` refs are re-based onto it. */
  function walk(node: unknown, dir: string, localBase: string | null, pointer: string, depth: number): unknown {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, dir, localBase, `${pointer}/${i}`, depth));
    if (!isBag(node)) return node;
    const ref = node.$ref;
    if (typeof ref === "string") {
      if (ref.startsWith("#")) return localBase === null ? node : { ...node, $ref: `${localBase}${ref.slice(1)}` };
      const local = localize(ref, dir, pointer, depth);
      const { $ref: _ref, ...rest } = node;
      void _ref;
      return local === null ? { ...rest, description: typeof rest.description === "string" ? rest.description : `Unresolved reference: ${boundText(ref, 160)}` } : { ...rest, $ref: local };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      // a schema's `enum` / `const` / `default` / `example(s)` hold data, not schemas: a `$ref` string there is a value
      out[k] = k === "enum" || k === "const" || k === "default" || k === "examples" || k === "example" ? v : walk(v, dir, localBase, `${pointer}/${k}`, depth);
    }
    return out;
  }

  const walked = walk(root, "", null, "", 0) as Record<string, unknown>;
  if (keyOfPath.size === 0) return { document: walked, warnings, inlined: [] };
  const components = isBag(walked.components) ? { ...(walked.components as Record<string, unknown>) } : {};
  components.schemas = { ...(isBag(components.schemas) ? (components.schemas as Record<string, unknown>) : {}), ...registered };
  return { document: { ...walked, components }, warnings, inlined: [...keyOfPath.keys()] };
}
