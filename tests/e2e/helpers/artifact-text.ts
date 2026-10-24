/**
 * What the lifecycle specs do with a generated artifact's text, without Playwright in it (unit tested).
 *
 * A multi-file version reaches a spec as a `===== path =====` bundle (`readPreview`), which is not one YAML / JSON document, so both
 * helpers work file by file (`splitBundle`). A single file (the DB targets, a stand-alone entity without an enum) has no header and
 * is its one file, exactly as before.
 *
 * JSON Schema is written one file per declaration (`emitAllModels`, no `bundleId`): the entity's own `<Entity>.json` and a
 * `<Entity>_<field>.json` for each of its inline enums, so enum values are NOT in the entity's file.
 */

import { parse as parseYaml } from "yaml";
import { splitBundle } from "./preview-text";

type BundleFile = { path: string; content: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The file's name without directories and without its `.json` / `.yaml` / `.yml` extension. */
function stem(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.(json|ya?ml)$/i, "");
}

/** Whether the file is named after the entity: its whole name (`Ticket.json`) or its last dotted segment (`openapi.Sales.Orders.Ticket.yaml`). */
function isNamedAfter(path: string, entityName: string): boolean {
  const name = stem(path);
  const last = name.slice(name.lastIndexOf(".") + 1);
  return norm(name) === norm(entityName) || norm(last) === norm(entityName);
}

/** The files with the one named after the entity first, the others in their order (no match: unchanged, the first file is the root's). */
export function rootFirst(files: ReadonlyArray<BundleFile>, entityName: string): BundleFile[] {
  const root = files.find((file) => isNamedAfter(file.path, entityName));
  return root ? [root, ...files.filter((file) => file !== root)] : [...files];
}

/**
 * The artifact as compact JSON when it parses (JSON or YAML), so one spelling of a substring matches either output syntax. Each file
 * of a bundle is canonicalized on its own (one that does not parse stays raw) and the files are joined with a newline.
 */
export function canon(text: string): string {
  return splitBundle(text)
    .map((file) => {
      try {
        return JSON.stringify(parseYaml(file.content));
      } catch {
        return file.content;
      }
    })
    .join("\n");
}

/** `required` of a schema in one parsed file: the one keyed or titled after the entity, or, in the ROOT file, the document itself (a per-model JSON Schema file). */
function requiredInFile(content: string, entityName: string, isRoot: boolean): string[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return null;
  }
  const seen = new Set<unknown>();
  let best: string[] | null = null;
  const walk = (node: unknown, key: string) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.required) && (norm(key) === norm(entityName) || norm(String(o.title ?? "")) === norm(entityName))) {
      best = o.required.map(String);
    }
    for (const [k, v] of Object.entries(o)) walk(v, k);
  };
  walk(doc, "");
  if (best === null && isRoot && doc && typeof doc === "object") {
    const top = doc as Record<string, unknown>;
    // The emitter writes a model as a file of its own with no title and no key: the document IS the entity's schema.
    if (Array.isArray(top.required) && top.properties && typeof top.properties === "object") best = top.required.map(String);
  }
  return best;
}

/**
 * `required` of the entity's own schema in a JSON Schema / OpenAPI text that has an own property list. In a multi-file bundle the
 * entity's file (the one named after it, else the first) is read first, and only a file that names the entity itself can answer after it.
 */
export function requiredOf(text: string, entityName: string): string[] | null {
  const ordered = rootFirst(splitBundle(text), entityName);
  for (const [index, file] of ordered.entries()) {
    const found = requiredInFile(file.content, entityName, index === 0);
    if (found) return found;
  }
  return null;
}
