/**
 * One JSON Schema file per entity.
 *
 * `@typespec/json-schema` without `bundleId` writes one file per declaration: `<Entity>.json` plus a `<Entity>_<field>.json` for every
 * inline enum / union / scalar (and a library model such as `RecordUnknown.json` a field points at). An entity is ONE schema, so those
 * files are folded into the entity's own file: each becomes an entry of its `$defs` and the file `$ref`s between them become local
 * `#/$defs/<Name>` refs. A `$ref` to ANOTHER entity's file stays a file ref: that is the cross-schema link, and the other entity keeps
 * its own file. Pure and deterministic; an unparsable file leaves the whole list as it was.
 */

import { setOwn } from "@/lib/event-specs/own-property";
import { mapSchemaRefs } from "@/lib/event-specs/json-schema-keywords";
import type { JsonObject } from "@/lib/event-specs/types";

type File = { path: string; content: string; entityId?: string };

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const stemOf = (path: string): string => (path.split("/").pop() ?? path).replace(/\.json$/, "");

function parse(content: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(content);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The file part of a `$ref` as a file stem (`Order_status.json#/x` -> `Order_status`); `null` when the ref has no file part. */
function refStem(ref: string): string | null {
  const file = ref.split("#")[0];
  return file === "" ? null : stemOf(file);
}

function refsOf(schema: JsonObject): string[] {
  const refs: string[] = [];
  mapSchemaRefs(schema, (ref) => {
    refs.push(ref);
    return ref;
  });
  return refs;
}

/**
 * @param rootStems entity id -> the stem of that entity's own file (its model name).
 * @returns the list with each entity's declaration files folded into its root file; files of no entity are kept as they are.
 */
export function mergeEntityJsonSchemaFiles<T extends File>(files: readonly T[], rootStems: ReadonlyMap<string, string>): T[] {
  const parsed = new Map<string, JsonObject>();
  for (const file of files) {
    if (!file.path.endsWith(".json")) continue;
    const schema = parse(file.content);
    if (schema === null) return [...files];
    parsed.set(file.path, schema);
  }
  const byStem = new Map<string, T>();
  for (const file of files) if (parsed.has(file.path)) byStem.set(stemOf(file.path), file);
  const allRootStems = new Set(rootStems.values());

  const out: T[] = [];
  const folded = new Set<string>();
  for (const [entityId, rootStem] of rootStems) {
    const root = files.find((f) => f.entityId === entityId && parsed.has(f.path) && stemOf(f.path) === rootStem);
    if (root === undefined) continue;

    // What goes into `$defs`: the entity's own declaration files, then whatever those point at that is not another entity's root file.
    const members = new Set<string>(files.filter((f) => f.entityId === entityId && parsed.has(f.path) && f !== root).map((f) => stemOf(f.path)));
    const queue = [root.path, ...[...members].map((s) => byStem.get(s)?.path ?? "")];
    while (queue.length > 0) {
      const schema = parsed.get(queue.shift() ?? "");
      if (schema === undefined) continue;
      for (const ref of refsOf(schema)) {
        const stem = refStem(ref);
        if (stem === null || stem === rootStem || allRootStems.has(stem) || members.has(stem)) continue;
        const target = byStem.get(stem);
        if (target === undefined) continue;
        members.add(stem);
        queue.push(target.path);
      }
    }

    const rewrite = (owner: string) => (ref: string): string => {
      const hash = ref.indexOf("#");
      const fragment = hash < 0 ? "" : ref.slice(hash + 1);
      const stem = refStem(ref);
      if (stem === null) return owner === rootStem ? ref : `#/$defs/${owner}${fragment}`;
      if (stem === rootStem) return `#${fragment}`;
      return members.has(stem) ? `#/$defs/${stem}${fragment}` : ref;
    };

    const rootSchema = mapSchemaRefs(parsed.get(root.path) as JsonObject, rewrite(rootStem));
    const defs: JsonObject = isObject(rootSchema.$defs) ? { ...rootSchema.$defs } : {};
    for (const stem of [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (Object.prototype.hasOwnProperty.call(defs, stem)) continue;
      const schema = mapSchemaRefs(parsed.get(byStem.get(stem)?.path ?? "") as JsonObject, rewrite(stem));
      const def: JsonObject = {};
      for (const [k, v] of Object.entries(schema)) if (k !== "$schema" && k !== "$id") setOwn(def, k, v);
      setOwn(defs, stem, def);
    }
    const merged: JsonObject = {};
    for (const [k, v] of Object.entries(rootSchema)) if (k !== "$defs") setOwn(merged, k, v);
    if (Object.keys(defs).length > 0) setOwn(merged, "$defs", defs);

    out.push({ ...root, content: `${JSON.stringify(merged, null, 2)}\n` });
    folded.add(root.path);
    for (const stem of members) {
      const own = files.find((f) => f.entityId === entityId && stemOf(f.path) === stem && parsed.has(f.path));
      if (own) folded.add(own.path);
    }
  }
  // Files that were not folded into a root stay (another entity's root, a shared file no entity adopted...); a folded file is replaced.
  return [...files.filter((f) => !folded.has(f.path)), ...out].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
