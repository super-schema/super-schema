/**
 * An emitted OpenAPI document read back for the API tab's preview: one entry per operation (method, path, summary, parameters,
 * request body and responses), each body with an example payload from `openapi-sampler` (which resolves the document's own
 * `$ref`s). Pure and client-safe; never throws (a document it cannot read is `{ error }`).
 */

import { sample } from "openapi-sampler";
import { parse as parseYaml } from "yaml";

export interface PreviewParameter {
  name: string;
  in: string;
  required: boolean;
  /** `string`, `integer (int64)`, `Order`, `string[]`, ... */
  type: string;
  description: string;
}

export interface PreviewBody {
  contentType: string;
  type: string;
  /** Pretty-printed example payload ("" when none could be made). */
  example: string;
}

export interface PreviewResponse {
  status: string;
  description: string;
  body: PreviewBody | null;
}

export interface PreviewOperation {
  method: string;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  parameters: PreviewParameter[];
  requestBody: (PreviewBody & { required: boolean }) | null;
  responses: PreviewResponse[];
}

export type OpenApiPreview =
  | { title: string; version: string; openapi: string; operations: PreviewOperation[]; error?: undefined }
  | { error: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const MAX_EXAMPLE_CHARS = 4000;

function resolveLocal(doc: Json, node: unknown): unknown {
  let current = node;
  for (let hop = 0; hop < 10 && isObject(current) && typeof current.$ref === "string"; hop++) {
    const ref = current.$ref;
    if (!ref.startsWith("#/")) return current;
    let next: unknown = doc;
    for (const key of ref.slice(2).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      next = isObject(next) ? next[key] : undefined;
    }
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/** A short type label of a schema. */
export function schemaLabel(schema: unknown, depth = 0): string {
  if (!isObject(schema) || depth > 5) return "any";
  if (typeof schema.$ref === "string") return schema.$ref.split("/").pop() ?? "any";
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    const parts = schema[key];
    if (Array.isArray(parts)) {
      const labels = parts.map((p) => schemaLabel(p, depth + 1)).filter((l) => l !== "null");
      return labels.length === 1 ? labels[0] : labels.join(key === "allOf" ? " & " : " | ");
    }
  }
  const type = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null").join(" | ") : str(schema.type);
  if (type === "array") return `${schemaLabel(schema.items, depth + 1)}[]`;
  if (!type && schema.properties) return "object";
  const format = str(schema.format);
  return format ? `${type || "string"} (${format})` : type || "any";
}

function exampleOf(schema: unknown, doc: Json): string {
  if (!isObject(schema)) return "";
  try {
    const value = sample(schema as Parameters<typeof sample>[0], { skipReadOnly: false, quiet: true }, doc);
    if (value === undefined) return "";
    const text = JSON.stringify(value, null, 2);
    return text.length > MAX_EXAMPLE_CHARS ? `${text.slice(0, MAX_EXAMPLE_CHARS)}\n…` : text;
  } catch {
    return "";
  }
}

function bodyOf(content: unknown, doc: Json): PreviewBody | null {
  if (!isObject(content)) return null;
  const [contentType] = Object.keys(content);
  if (!contentType) return null;
  const media = content[contentType];
  const schema = isObject(media) ? media.schema : undefined;
  return { contentType, type: schemaLabel(schema), example: exampleOf(schema, doc) };
}

/** Read an OpenAPI document (YAML or JSON text, or an already parsed object) into preview entries. */
export function summarizeOpenApi(input: string | object): OpenApiPreview {
  let doc: unknown = input;
  if (typeof input === "string") {
    try {
      doc = parseYaml(input);
    } catch {
      return { error: "The generated document is not valid YAML" };
    }
  }
  if (!isObject(doc) || (typeof doc.openapi !== "string" && typeof doc.swagger !== "string")) return { error: "Not an OpenAPI document" };
  const info = isObject(doc.info) ? doc.info : {};
  const operations: PreviewOperation[] = [];
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolveLocal(doc, rawItem);
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map((p) => resolveLocal(doc as Json, p))
        .filter(isObject)
        .map((p) => ({
          name: str(p.name),
          in: str(p.in),
          required: p.required === true,
          type: schemaLabel(p.schema),
          description: str(p.description),
        }));
      const body = isObject(op.requestBody) ? resolveLocal(doc, op.requestBody) : undefined;
      const requestBodyContent = isObject(body) ? bodyOf(body.content, doc) : null;
      const responses = isObject(op.responses)
        ? Object.entries(op.responses).map(([status, raw]) => {
            const r = resolveLocal(doc as Json, raw);
            return { status, description: isObject(r) ? str(r.description) : "", body: isObject(r) ? bodyOf(r.content, doc as Json) : null };
          })
        : [];
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: str(op.operationId),
        summary: str(op.summary),
        description: str(op.description),
        tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [],
        deprecated: op.deprecated === true,
        parameters: params,
        requestBody: requestBodyContent ? { ...requestBodyContent, required: isObject(body) && body.required === true } : null,
        responses,
      });
    }
  }
  return { title: str(info.title), version: str(info.version), openapi: str(doc.openapi) || str(doc.swagger), operations };
}
