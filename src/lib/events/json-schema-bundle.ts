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

  const problems: string[] = [];
  const rewrite = (owner: string) => (ref: string): string => {
    const hash = ref.indexOf("#");
    const file = hash < 0 ? ref : ref.slice(0, hash);
    const fragment = hash < 0 ? "" : ref.slice(hash + 1);
    if (file === "") return owner === rootModel ? ref : `#/$defs/${owner}${fragment}`;
    const target = nameById.get(file);
    if (!target) {
      problems.push(`unresolvable $ref "${ref}" in ${owner}`);
      return ref;
    }
    return target === rootModel ? `#${fragment}` : `#/$defs/${target}${fragment}`;
  };

  const rootSchema = mapSchemaRefs(withoutKeys(root[1], ["$schema", "$id"]), rewrite(rootModel));
  const defs: JsonObject = isJsonObject(rootSchema.$defs) ? { ...rootSchema.$defs } : {};
  for (const [name, schema] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (name === rootModel) continue;
    if (name in defs) {
      problems.push(`$defs name clash "${name}"`);
      continue;
    }
    defs[name] = mapSchemaRefs(withoutKeys(schema, ["$schema", "$id"]), rewrite(name));
  }
  if (problems.length > 0) return err({ code: "SCHEMA_BUNDLE_UNRESOLVED", message: problems.join("; "), details: { problems } });

  const out: JsonObject = { $schema: DRAFT_2020_12, ...withoutKeys(rootSchema, ["$defs"]) };
  if (Object.keys(defs).length > 0) out.$defs = defs;
  return ok(out);
}
