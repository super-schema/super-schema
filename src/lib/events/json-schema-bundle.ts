import { mapSchemaRefs } from "@/lib/event-specs/json-schema-keywords";
import type { JsonObject } from "@/lib/event-specs/types";
import { isJsonObject } from "./inputs";
import { ok, err, type Result } from "@/types/result";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

function withoutKeys(schema: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/**
 * D9: `@typespec/json-schema` with `bundleId` writes `{ $id: <bundle>, $defs: { Order: { $id: "Order.json", … } } }`
 * whose cross-model refs are file refs (`"Address.json"`). AsyncAPI documents must not carry
 * non-local refs (REMOTE_REF), so the root model becomes the schema and every other model a local
 * `#/$defs/<Name>`; refs are rewritten in schema positions only (mapSchemaRefs).
 */
export function inlineJsonSchemaBundle(bundle: JsonObject, rootModel: string): Result<JsonObject> {
  const bundled = isJsonObject(bundle.$defs) && bundle.type === undefined && bundle.properties === undefined;
  const entries: Array<[string, JsonObject]> = bundled
    ? Object.entries(bundle.$defs as JsonObject).filter((e): e is [string, JsonObject] => isJsonObject(e[1]))
    : [[rootModel, bundle]];

  const nameById = new Map<string, string>();
  for (const [name, schema] of entries) {
    nameById.set(`${name}.json`, name);
    if (typeof schema.$id === "string") nameById.set(schema.$id, name);
  }
  const root = entries.find(([name]) => name === rootModel);
  if (!root) return err({ code: "ROOT_SCHEMA_NOT_FOUND", message: `JSON Schema bundle has no schema for "${rootModel}"` });

  const problemsByOwner = new Map<string, string[]>();
  const rewrite = (owner: string) => (ref: string): string => {
    const hash = ref.indexOf("#");
    const file = hash < 0 ? ref : ref.slice(0, hash);
    const fragment = hash < 0 ? "" : ref.slice(hash + 1);
    if (file === "") return owner === rootModel ? ref : `#/$defs/${owner}${fragment}`;
    const target = nameById.get(file);
    if (!target) {
      problemsByOwner.set(owner, [...(problemsByOwner.get(owner) ?? []), `unresolvable $ref "${ref}" in ${owner}`]);
      return ref;
    }
    return target === rootModel ? `#${fragment}` : `#/$defs/${target}${fragment}`;
  };

  const rootSchema = mapSchemaRefs(withoutKeys(root[1], ["$schema", "$id"]), rewrite(rootModel));
  const allDefs: JsonObject = isJsonObject(rootSchema.$defs) ? { ...rootSchema.$defs } : {};
  const clashes: string[] = [];
  for (const [name, schema] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === rootModel) continue;
    if (Object.prototype.hasOwnProperty.call(allDefs, name)) {
      clashes.push(name);
      continue;
    }
    allDefs[name] = mapSchemaRefs(withoutKeys(schema, ["$schema", "$id"]), rewrite(name));
  }

  // Only what the root reaches stays: the emitter writes every model it saw (`emitAllModels`), including library
  // types a source happens to import, and none of those belong in a message payload schema.
  const body = withoutKeys(rootSchema, ["$defs"]);
  const reachable = reachableDefs(body, allDefs);
  const defs: JsonObject = {};
  for (const name of Object.keys(allDefs)) if (reachable.has(name)) defs[name] = allDefs[name];

  const problems = [
    ...(problemsByOwner.get(rootModel) ?? []),
    ...Object.keys(defs).flatMap((name) => problemsByOwner.get(name) ?? []),
    ...clashes.filter((name) => reachable.has(name)).map((name) => `$defs name clash "${name}"`),
  ];
  if (problems.length > 0) return err({ code: "SCHEMA_BUNDLE_UNRESOLVED", message: problems.join("; "), details: { problems } });

  const out: JsonObject = { $schema: DRAFT_2020_12, ...body };
  if (Object.keys(defs).length > 0) out.$defs = defs;
  return ok(out);
}

const LOCAL_DEF_REF = "#/$defs/";

function collectDefRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDefRefs(item, into);
  } else if (isJsonObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith(LOCAL_DEF_REF)) {
        const encoded = value.slice(LOCAL_DEF_REF.length).split("/")[0];
        let name = encoded;
        try {
          name = decodeURIComponent(encoded);
        } catch {
          // keep the raw segment
        }
        into.add(name.replace(/~1/g, "/").replace(/~0/g, "~"));
      } else collectDefRefs(value, into);
    }
  }
}

/** Names of the `$defs` reachable from `root` through local `$ref`s (cycle-safe). */
function reachableDefs(root: JsonObject, defs: JsonObject): Set<string> {
  const reachable = new Set<string>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const refs = new Set<string>();
    collectDefRefs(queue.shift(), refs);
    for (const name of refs) {
      if (reachable.has(name) || !Object.prototype.hasOwnProperty.call(defs, name)) continue;
      reachable.add(name);
      queue.push(defs[name]);
    }
  }
  return reachable;
}
