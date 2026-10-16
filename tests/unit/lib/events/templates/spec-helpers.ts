// Test helper: reads the AsyncAPI 3.0 JSON Schema out of node_modules (`@asyncapi/specs` is a transitive dependency of
// @asyncapi/parser, so it is read here and in the generator script only — never at runtime).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** Directory of the installed `@asyncapi/specs` package. */
export const SPECS_ROOT = path.dirname(nodeRequire.resolve("@asyncapi/specs"));

export interface SpecSchema {
  $ref?: string;
  type?: string | string[];
  enum?: string[];
  properties?: Record<string, SpecSchema>;
  required?: string[];
  allOf?: SpecSchema[];
  not?: { required?: string[] };
}

const SCHEMA_3_0_0 = JSON.parse(fs.readFileSync(path.join(SPECS_ROOT, "schemas", "3.0.0.json"), "utf8")) as { definitions: Record<string, SpecSchema> };
const DEFINITION_PREFIX = "http://asyncapi.com/definitions/3.0.0/";

export function specDefinition(name: string): SpecSchema {
  const found = SCHEMA_3_0_0.definitions[`${DEFINITION_PREFIX}${name}.json`];
  if (!found) throw new Error(`No AsyncAPI 3.0.0 definition "${name}"`);
  return found;
}

const isExtension = (key: string) => key.startsWith("x-");

/** Every non-`x-` property of a definition, following `allOf` and `$ref` (info and message compose their properties). */
export function collectSpecProperties(name: string): { properties: Record<string, SpecSchema>; required: string[] } {
  const properties: Record<string, SpecSchema> = {};
  const required = new Set<string>();
  const seen = new Set<SpecSchema>();
  const visit = (schema: SpecSchema | undefined) => {
    if (!schema || seen.has(schema)) return;
    seen.add(schema);
    if (schema.$ref) visit(SCHEMA_3_0_0.definitions[schema.$ref]);
    for (const [key, value] of Object.entries(schema.properties ?? {})) if (!isExtension(key)) properties[key] = value;
    for (const key of schema.required ?? []) required.add(key);
    for (const branch of schema.allOf ?? []) visit(branch);
  };
  visit(specDefinition(name));
  return { properties, required: [...required] };
}
