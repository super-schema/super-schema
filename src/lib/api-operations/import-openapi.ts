/**
 * OpenAPI document -> API operations (the `api-operation.ts` contract), for the entity API tab's "Import OpenAPI".
 *
 * Pipeline (never throws; every failure is an `err` Result, every lossy step a warning):
 *   text -> size cap (`checkImportSize`) -> bounded YAML / JSON parse (`parseYamlBounded`: alias / expansion guards)
 *        -> version check (Swagger 2.0, OpenAPI 3.0, 3.1) -> `@scalar/openapi-parser` `validate`
 *        -> `@scalar/openapi-upgrader` to 3.1 -> `paths` mapped to `ApiOperation[]`.
 * A URL is fetched with the JSON Schema importer's guarded root fetch (`fetchRootDocument`: https only, public hosts only, the
 * internal git hosts through `gh`, size and time limits); nothing else is ever fetched: an external `$ref` is reported, not followed.
 *
 * Mapping. The document is NOT dereferenced wholesale: a `$ref` to `#/components/schemas/<Name>` is exactly the entity / data-type
 * name the contract wants (`Pet`, `Pet[]`). A referenced component that is only a primitive (`Id: {type: string, format: uuid}`) maps
 * to that primitive. Parameters, request bodies and responses that are `$ref`s to `#/components/...` are resolved locally. Primitives
 * collapse `type` + `format` into `PRIMITIVE_TYPES`. What the contract cannot hold (inline object schemas, `oneOf` / `anyOf` bodies,
 * `default` / `2XX` responses, callbacks, webhooks, TRACE, nested arrays, ...) is skipped with a warning. Each operation is then checked
 * with the contract's own rules (`parseApiOperation` + `checkApiOperation` + `checkAgainstSiblings`); one that fails is skipped with a
 * warning, never imported half-valid.
 */

import { validate as validateOpenApi } from "@scalar/openapi-parser";
import { upgrade as upgradeOpenApi } from "@scalar/openapi-upgrader";

import { checkImportSize } from "@/lib/compiler/import-limits";
import { fetchRootDocument, type ResolverDeps } from "@/lib/importers/jsonschema-ref-resolver";
import { parseYamlBounded } from "@/lib/importers/safe-yaml";
import { sanitizeImportedText } from "@/lib/importers/text-safety";
import { err, ok, type Result } from "@/types/result";
import {
  HTTP_METHODS,
  PRIMITIVE_TYPES,
  type ApiOperation,
  type ApiParameter,
  type ApiRequestBody,
  type ApiResponse,
} from "@/types/schemas/api-operation";
import { METADATA_ATTRIBUTE_KEY_REGEX } from "@/types/schemas/metadata-attribute";
import { checkAgainstSiblings, checkApiOperation, formatIssues, parseApiOperation, pathPlaceholders } from "./validate";

/** At most this many operations are taken from one document; the rest are reported. */
export const MAX_IMPORTED_OPERATIONS = 500;
/** At most this many warnings are returned (the rest are counted in a final line). */
export const MAX_IMPORT_WARNINGS = 200;
/** A URL longer than this is refused before anything is fetched. */
export const MAX_OPENAPI_URL_LENGTH = 2048;

type Primitive = (typeof PRIMITIVE_TYPES)[number];
type Json = Record<string, unknown>;

export interface OpenApiImportResult {
  /** The operations found, each valid on its own and against the ones before it. */
  operations: ApiOperation[];
  /** Everything that was skipped, renamed or ignored, one sentence each. */
  warnings: string[];
  /** Entity / data-type names the operations refer to (sorted): they must exist for the emitted document to resolve them. */
  referencedTypes: string[];
  /** `info.title` / `info.version` of the document, when present. */
  title?: string;
  version?: string;
  /** The version the document was written in ("2.0", "3.0.3", "3.1.0", ...). */
  sourceVersion: string;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? sanitizeImportedText(v) : "");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+$/;
const SCHEMA_REF = /^#\/components\/schemas\/([^/]+)$/;
const OPENAPI_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const SUPPORTED_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);
const MAX_REF_HOPS = 20;
const MAX_SCHEMA_DEPTH = 16;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse, validate, upgrade and map an OpenAPI document given as YAML or JSON text. */
export async function parseOpenApiText(content: string): Promise<Result<OpenApiImportResult>> {
  try {
    if (typeof content !== "string" || !content.trim()) {
      return err({ code: "PARSE_ERROR", message: "Empty OpenAPI content", suggestedFix: "Paste or upload an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML)." });
    }
    const size = checkImportSize(content, "OpenAPI document");
    if (!size.success) return size;
    const parsed = parseYamlBounded(content.replace(/^﻿/, ""));
    if (!parsed.ok) {
      return err({
        code: "PARSE_ERROR",
        message: parsed.kind === "syntax" ? "The OpenAPI document is not valid YAML or JSON" : parsed.message.replace("The YAML document", "The OpenAPI document"),
        suggestedFix: parsed.kind === "syntax" ? "Ensure the content is valid YAML or JSON." : "Convert the document to JSON, or use $ref to components instead of YAML aliases.",
      });
    }
    return await importOpenApiDocument(parsed.value);
  } catch (e: unknown) {
    console.error("[parseOpenApiText] unexpected error", e);
    return err({ code: "PARSE_ERROR", message: "The OpenAPI document could not be imported" });
  }
}

/**
 * Fetch an OpenAPI document by URL with the importer's guarded fetch (https, public hosts, size / time limits) and return its text.
 * `deps` is a test seam (fetchers, DNS lookup); production callers pass none, which keeps every guard on.
 */
export async function fetchOpenApiText(url: string, deps: ResolverDeps = {}): Promise<Result<string>> {
  if (typeof url !== "string" || !url.trim()) {
    return err({ code: "VALIDATION_ERROR", message: "An OpenAPI URL is required", suggestedFix: "Provide an https URL of an OpenAPI document." });
  }
  if (url.length > MAX_OPENAPI_URL_LENGTH) {
    return err({ code: "VALIDATION_ERROR", message: `The URL is too long (the limit is ${MAX_OPENAPI_URL_LENGTH} characters)` });
  }
  const fetched = await fetchRootDocument(url.trim(), deps);
  if (!fetched.ok) {
    return err({ code: "FETCH_ERROR", message: `The OpenAPI document could not be loaded: ${fetched.reason}`, suggestedFix: "Check the URL and that the server can reach it." });
  }
  return ok(fetched.content);
}

/** Validate, upgrade and map an already parsed OpenAPI document. */
export async function importOpenApiDocument(value: unknown): Promise<Result<OpenApiImportResult>> {
  if (!isObject(value)) {
    return err({ code: "PARSE_ERROR", message: "The OpenAPI document must be an object", suggestedFix: "Provide an OpenAPI 3.x or Swagger 2.0 document." });
  }
  const sourceVersion = typeof value.swagger === "string" ? value.swagger : typeof value.openapi === "string" ? value.openapi : "";
  const supported = typeof value.swagger === "string" ? sourceVersion === "2.0" : /^3\.[01](\.\d+)?$/.test(sourceVersion);
  if (!supported) {
    return err({
      code: "UNSUPPORTED_VERSION",
      message: sourceVersion ? `OpenAPI version "${sourceVersion}" is not supported` : "Not an OpenAPI document (no `openapi` or `swagger` version)",
      suggestedFix: "Import a Swagger 2.0, OpenAPI 3.0 or OpenAPI 3.1 document.",
    });
  }

  const validation = await validateOpenApi(structuredClone(value));
  const errors = (validation.errors ?? []).filter((e) => e.code !== "EXTERNAL_REFERENCE_NOT_FOUND");
  if (!validation.valid && errors.length > 0) {
    const shown = errors.slice(0, 3).map((e) => `${Array.isArray(e.path) ? e.path.join("/") : (e.path ?? "")} ${e.message}`.trim());
    return err({
      code: "VALIDATION_ERROR",
      message: `The OpenAPI document is not valid: ${shown.join("; ")}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ""}`,
      suggestedFix: "Fix the document (an OpenAPI linter shows every issue) and import it again.",
      details: { issues: errors.slice(0, 50).map((e) => ({ path: Array.isArray(e.path) ? e.path.join("/") : "", message: e.message })) },
    });
  }

  const upgraded = (sourceVersion.startsWith("3.1") ? structuredClone(value) : upgradeOpenApi(structuredClone(value), "3.1")) as Json;
  const mapped = mapOpenApiOperations(upgraded);
  const info = isObject(value.info) ? value.info : {};
  return ok({
    ...mapped,
    ...(typeof info.title === "string" ? { title: text(info.title) } : {}),
    ...(typeof info.version === "string" ? { version: text(info.version) } : {}),
    sourceVersion,
  });
}

// ---------------------------------------------------------------------------
// Mapping (OpenAPI 3.1 document -> contract operations)
// ---------------------------------------------------------------------------

class Warnings {
  private readonly list: string[] = [];
  private readonly seen = new Set<string>();
  private dropped = 0;
  add(message: string) {
    if (this.seen.has(message)) return;
    this.seen.add(message);
    if (this.list.length < MAX_IMPORT_WARNINGS) this.list.push(message);
    else this.dropped++;
  }
  done(): string[] {
    return this.dropped ? [...this.list, `... and ${this.dropped} more warnings`] : this.list;
  }
}

interface Ctx {
  doc: Json;
  warn: Warnings;
  referenced: Set<string>;
}

/** JSON pointer (`#/a/b~1c`) inside the document; undefined when it does not resolve. */
function resolvePointer(doc: Json, ref: string): unknown {
  if (ref === "#") return doc;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = doc;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node) && Object.prototype.hasOwnProperty.call(node, key)) node = node[key];
    else return undefined;
  }
  return node;
}

/** A parameter / body / response object with its `$ref` chain followed (local refs only). */
function deref(ctx: Ctx, node: unknown, where: string): Json | null {
  let current = node;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    if (!isObject(current)) return null;
    if (typeof current.$ref !== "string") return current;
    const ref = current.$ref;
    if (!ref.startsWith("#")) {
      ctx.warn.add(`${where}: the external reference "${ref}" is not followed; it was skipped.`);
      return null;
    }
    const next = resolvePointer(ctx.doc, ref);
    if (next === undefined) {
      ctx.warn.add(`${where}: the reference "${ref}" does not resolve; it was skipped.`);
      return null;
    }
    current = next;
  }
  ctx.warn.add(`${where}: a reference chain is too long (or circular); it was skipped.`);
  return null;
}

/** A component name as a type name of the contract (`[A-Za-z_][A-Za-z0-9_]*`, dotted segments allowed). */
function typeNameOf(name: string): string {
  const segments = name.split(".").map((s) => {
    const safe = s.replace(/[^A-Za-z0-9_]/g, "_");
    return safe === "" ? "_" : /^[0-9]/.test(safe) ? `_${safe}` : safe;
  });
  return segments.join(".");
}

function primitiveOf(type: string, format: unknown): Primitive | null {
  const f = typeof format === "string" ? format : "";
  switch (type) {
    case "string":
      if (f === "date") return "date";
      if (f === "date-time") return "date-time";
      if (f === "uuid") return "uuid";
      if (f === "byte" || f === "binary" || f === "base64") return "bytes";
      return "string";
    case "integer":
      return f === "int64" ? "int64" : "int32";
    case "number":
      if (f === "float") return "float";
      if (f === "int32" || f === "int64") return f;
      return "double";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

/** The single non-null `type` of a schema (3.1 allows `["string", "null"]`); undefined when absent or ambiguous. */
function singleType(schema: Json): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    return types.length === 1 && typeof types[0] === "string" ? types[0] : undefined;
  }
  return undefined;
}

/** A primitive-only schema: a scalar type, no enum / properties / composition. */
function primitiveSchema(schema: Json): Primitive | null {
  if (schema.enum !== undefined || schema.const !== undefined || schema.properties !== undefined) return null;
  if (schema.allOf || schema.oneOf || schema.anyOf) return null;
  const type = singleType(schema) ?? (typeof schema.format === "string" ? "string" : undefined);
  return type ? primitiveOf(type, schema.format) : null;
}

type TypeRef = { type: string; isArray: boolean };

/** A schema as a contract type reference; null (with a warning) when the contract cannot express it. */
function schemaType(ctx: Ctx, schema: unknown, where: string, depth = 0): TypeRef | null {
  if (depth > MAX_SCHEMA_DEPTH) {
    ctx.warn.add(`${where}: the schema nests too deeply; it was skipped.`);
    return null;
  }
  if (!isObject(schema)) return null;

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const named = SCHEMA_REF.exec(ref);
    if (named) {
      const target = resolvePointer(ctx.doc, ref);
      if (target === undefined) {
        ctx.warn.add(`${where}: the reference "${ref}" does not resolve; it was skipped.`);
        return null;
      }
      if (isObject(target)) {
        const primitive = primitiveSchema(target);
        if (primitive) return { type: primitive, isArray: false };
        // `Pets: {type: array, items: {$ref: Pet}}` reads as Pet[] (the named array has no entity of its own)
        if (singleType(target) === "array" && !target.properties) return schemaType(ctx, target, where, depth + 1);
      }
      let raw = named[1];
      try {
        raw = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
      } catch {
        /* keep the raw segment */
      }
      const name = typeNameOf(raw);
      if (name !== raw) ctx.warn.add(`The schema name "${raw}" is not a valid type name; it is referred to as "${name}".`);
      ctx.referenced.add(name);
      return { type: name, isArray: false };
    }
    if (!ref.startsWith("#")) {
      ctx.warn.add(`${where}: the external reference "${ref}" is not followed; it was skipped.`);
      return null;
    }
    const target = resolvePointer(ctx.doc, ref);
    if (target === undefined) {
      ctx.warn.add(`${where}: the reference "${ref}" does not resolve; it was skipped.`);
      return null;
    }
    return schemaType(ctx, target, where, depth + 1);
  }

  // Composition: a single wrapped schema, or "X or null", is X; anything else has no contract form.
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    const parts = schema[key];
    if (!Array.isArray(parts)) continue;
    const meaningful = parts.filter((p) => !(isObject(p) && (p.type === "null" || (Array.isArray(p.enum) && p.enum.length === 1 && p.enum[0] === null))));
    if (meaningful.length === 1) return schemaType(ctx, meaningful[0], where, depth + 1);
    ctx.warn.add(`${where}: a ${key} schema (${meaningful.length} alternatives) is not supported; it was skipped.`);
    return null;
  }

  const type = singleType(schema);
  if (Array.isArray(schema.type) && type === undefined) {
    ctx.warn.add(`${where}: a schema of several types (${schema.type.join(", ")}) is not supported; it was skipped.`);
    return null;
  }
  if (type === "array") {
    if (schema.items === undefined) {
      ctx.warn.add(`${where}: an array without \`items\` is not supported; it was skipped.`);
      return null;
    }
    const item = schemaType(ctx, schema.items, `${where} (items)`, depth + 1);
    if (!item) return null;
    if (item.isArray) {
      ctx.warn.add(`${where}: an array of arrays is not supported; it was skipped.`);
      return null;
    }
    return { type: item.type, isArray: true };
  }
  if (type === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
    const title = typeof schema.title === "string" ? schema.title.trim() : "";
    ctx.warn.add(
      `${where}: an inline object schema${title ? ` ("${title}")` : ""} has no named type; it was skipped. Move it to components.schemas and refer to it with $ref.`
    );
    return null;
  }
  const primitive = type ? primitiveOf(type, schema.format) : typeof schema.format === "string" ? primitiveOf("string", schema.format) : null;
  if (primitive) return { type: primitive, isArray: false };
  if (type === "null") return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const kinds = new Set(schema.enum.map((v) => typeof v));
    if (kinds.size === 1 && kinds.has("string")) return { type: "string", isArray: false };
    if (kinds.size === 1 && kinds.has("number")) return { type: schema.enum.every((v) => Number.isInteger(v)) ? "int32" : "double", isArray: false };
    if (kinds.size === 1 && kinds.has("boolean")) return { type: "boolean", isArray: false };
  }
  ctx.warn.add(`${where}: a schema without a type is not supported; it was skipped.`);
  return null;
}

/** The media type of a content map to use: JSON first, then any `+json`, then the first one. */
function pickContent(ctx: Ctx, content: unknown, where: string): { contentType: string; schema: unknown } | null {
  if (!isObject(content)) return null;
  const keys = Object.keys(content);
  if (keys.length === 0) return null;
  const base = (k: string) => k.split(";")[0].trim().toLowerCase();
  const chosen =
    keys.find((k) => base(k) === "application/json") ?? keys.find((k) => /\+json$/.test(base(k))) ?? keys.find((k) => base(k).endsWith("/json")) ?? keys[0];
  if (keys.length > 1) {
    const others = keys.filter((k) => k !== chosen);
    ctx.warn.add(`${where}: only the "${chosen}" content is imported (also declared: ${others.join(", ")}).`);
  }
  let contentType = base(chosen);
  if (!MEDIA_TYPE.test(contentType)) {
    const fallback = contentType === "*/*" ? "application/octet-stream" : "application/json";
    ctx.warn.add(`${where}: the content type "${chosen}" is not a concrete media type; imported as "${fallback}".`);
    contentType = fallback;
  }
  const media = content[chosen];
  return { contentType, schema: isObject(media) ? media.schema : undefined };
}

function camel(words: string[]): string {
  return words
    .map((w, i) => {
      const clean = w.replace(/[^A-Za-z0-9]/g, "");
      if (!clean) return "";
      return i === 0 ? clean.charAt(0).toLowerCase() + clean.slice(1) : clean.charAt(0).toUpperCase() + clean.slice(1);
    })
    .join("");
}

/** `GET /pets/{petId}/toys` -> `getPetsByPetIdToys`. */
function derivedName(method: string, path: string): string {
  const words = [method.toLowerCase()];
  for (const segment of path.split("/").filter(Boolean)) {
    const placeholder = /^\{(.+)\}$/.exec(segment);
    if (placeholder) words.push("by", ...placeholder[1].split(/[^A-Za-z0-9]+/));
    else words.push(...segment.split(/[^A-Za-z0-9]+/));
  }
  const name = camel(words);
  return IDENTIFIER.test(name) ? name : `op_${name}`;
}

/** An operationId as an identifier: `pets.list` / `list-pets` -> `pets_list` / `list_pets`. */
function identifierOf(raw: string): string {
  let id = raw.trim().replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

interface RawParam {
  name: string;
  in: string;
  node: Json;
}

function collectParams(ctx: Ctx, list: unknown, where: string): RawParam[] {
  if (!Array.isArray(list)) return [];
  const out: RawParam[] = [];
  list.forEach((p, i) => {
    const node = deref(ctx, p, `${where} parameter ${i + 1}`);
    if (!node) return;
    if (typeof node.name !== "string" || typeof node.in !== "string") return;
    out.push({ name: node.name, in: node.in, node });
  });
  return out;
}

function mapOperation(
  ctx: Ctx,
  method: (typeof OPENAPI_METHODS)[number],
  rawPath: string,
  pathItem: Json,
  op: Json,
  names: Set<string>
): ApiOperation | null {
  const httpMethod = method.toUpperCase();
  const label = `${httpMethod} ${rawPath}`;
  if (!SUPPORTED_METHODS.has(httpMethod)) {
    ctx.warn.add(`${label}: the ${httpMethod} method is not supported; the operation was skipped.`);
    return null;
  }
  if (!rawPath.startsWith("/")) {
    ctx.warn.add(`${label}: the path does not start with "/"; the operation was skipped.`);
    return null;
  }
  if (isObject(op.callbacks) && Object.keys(op.callbacks).length > 0) ctx.warn.add(`${label}: callbacks are not imported.`);
  if (Array.isArray(op.servers) && op.servers.length > 0) ctx.warn.add(`${label}: operation-level servers are not imported.`);

  // Path-level parameters, overridden by operation-level ones of the same name + location.
  const merged = new Map<string, RawParam>();
  for (const p of [...collectParams(ctx, pathItem.parameters, label), ...collectParams(ctx, op.parameters, label)]) {
    merged.set(`${p.in}:${p.in === "header" ? p.name.toLowerCase() : p.name}`, p);
  }

  let httpPath = rawPath;
  const parameters: ApiParameter[] = [];
  for (const p of merged.values()) {
    const where = `${label} ${p.in} parameter "${p.name}"`;
    if (p.in !== "path" && p.in !== "query" && p.in !== "header" && p.in !== "cookie") {
      ctx.warn.add(`${where}: the location "${p.in}" is not supported; the parameter was skipped.`);
      continue;
    }
    if (p.in === "header" && ["accept", "content-type", "authorization"].includes(p.name.toLowerCase())) {
      ctx.warn.add(`${where}: OpenAPI ignores a parameter named ${p.name}; it was skipped.`);
      continue;
    }
    let name = p.name;
    if (p.in === "header" ? !HEADER_TOKEN.test(name) : !IDENTIFIER.test(name)) {
      if (p.in === "path") {
        // a path parameter's name is not on the wire: renamed together with its {placeholder}
        const renamed = identifierOf(name) || "param";
        httpPath = httpPath.split(`{${name}}`).join(`{${renamed}}`);
        ctx.warn.add(`${where}: renamed to "${renamed}" (a path parameter must be an identifier).`);
        name = renamed;
      } else {
        ctx.warn.add(`${where}: the name is not supported for a ${p.in} parameter (it must be ${p.in === "header" ? "a header token" : "an identifier"}); the parameter was skipped.`);
        continue;
      }
    }
    let typeRef: TypeRef | null = null;
    if (p.node.schema !== undefined) typeRef = schemaType(ctx, p.node.schema, where);
    else if (p.node.content !== undefined) {
      const picked = pickContent(ctx, p.node.content, where);
      typeRef = picked ? schemaType(ctx, picked.schema, where) : null;
    }
    if (!typeRef) {
      ctx.warn.add(`${where}: imported as a string (its schema has no contract form).`);
      typeRef = { type: "string", isArray: false };
    }
    parameters.push({
      name,
      location: p.in,
      type: typeRef.type,
      isArray: typeRef.isArray,
      required: p.in === "path" ? true : p.node.required === true,
      description: text(p.node.description),
    });
  }

  // {placeholders} vs path parameters: add what the path names, drop what it does not.
  const placeholders = new Set(pathPlaceholders(httpPath));
  for (const name of placeholders) {
    if (!parameters.some((p) => p.location === "path" && p.name === name)) {
      ctx.warn.add(`${label}: the path parameter {${name}} is not declared; it was added as a string.`);
      parameters.push({ name, location: "path", type: "string", isArray: false, required: true, description: "" });
    }
  }
  const kept = parameters.filter((p) => {
    if (p.location !== "path" || placeholders.has(p.name)) return true;
    ctx.warn.add(`${label}: the path parameter "${p.name}" does not appear in the path; it was skipped.`);
    return false;
  });

  let requestBody: ApiRequestBody | null = null;
  if (op.requestBody !== undefined) {
    const body = deref(ctx, op.requestBody, `${label} request body`);
    if (body) {
      const picked = pickContent(ctx, body.content, `${label} request body`);
      const typeRef = picked ? schemaType(ctx, picked.schema, `${label} request body`) : null;
      if (picked && typeRef) {
        requestBody = { ...typeRef, contentType: picked.contentType, required: body.required === true, description: text(body.description) };
      } else {
        ctx.warn.add(`${label}: the request body was not imported.`);
      }
    }
  }

  const responses: ApiResponse[] = [];
  if (isObject(op.responses)) {
    for (const [code, raw] of Object.entries(op.responses)) {
      const where = `${label} response ${code}`;
      if (!/^[1-5][0-9][0-9]$/.test(code)) {
        ctx.warn.add(`${where}: ${code === "default" ? "the default response" : "a status code range"} is not supported; it was skipped.`);
        continue;
      }
      const response = deref(ctx, raw, where);
      if (!response) continue;
      if (isObject(response.links) && Object.keys(response.links).length > 0) ctx.warn.add(`${where}: links are not imported.`);
      const picked = pickContent(ctx, response.content, where);
      const typeRef = picked && picked.schema !== undefined ? schemaType(ctx, picked.schema, where) : null;
      if (picked && picked.schema !== undefined && !typeRef) ctx.warn.add(`${where}: imported without a body type.`);
      responses.push({
        statusCode: Number(code),
        type: typeRef ? typeRef.type : null,
        isArray: typeRef ? typeRef.isArray : false,
        contentType: typeRef && picked ? picked.contentType : "application/json",
        description: text(response.description),
      });
    }
  }

  const rawId = typeof op.operationId === "string" ? op.operationId.trim() : "";
  let base = rawId ? identifierOf(rawId) : derivedName(method, httpPath);
  if (!IDENTIFIER.test(base)) base = derivedName(method, httpPath);
  if (rawId && base !== rawId) ctx.warn.add(`${label}: the operationId "${rawId}" is not an identifier; imported as "${base}".`);
  const name = uniqueName(base, names);
  if (name !== base) ctx.warn.add(`${label}: the name "${base}" is already used by another operation; imported as "${name}".`);

  return {
    name,
    summary: text(op.summary),
    description: text(op.description),
    httpMethod: httpMethod as ApiOperation["httpMethod"],
    httpPath,
    tags: Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string").map(text) : [],
    deprecated: op.deprecated === true,
    parameters: kept,
    requestBody,
    responses,
    ...operationExtensions(op),
  };
}

/** The operation's own `x-*` keys that follow the attribute key rule, as `{ extensions }` (nothing when there are none). */
function operationExtensions(op: Json): Pick<ApiOperation, "extensions"> {
  const kept = Object.entries(op).filter(([k, v]) => METADATA_ATTRIBUTE_KEY_REGEX.test(k) && k.length <= 64 && v !== undefined);
  return kept.length > 0 ? { extensions: Object.fromEntries(kept) as NonNullable<ApiOperation["extensions"]> } : {};
}

/**
 * The operations of an OpenAPI 3.1 document (`paths`), each checked with the contract's rules; unsupported constructs and
 * operations that fail a rule are reported in `warnings`. Pure.
 */
export function mapOpenApiOperations(doc: Json): Pick<OpenApiImportResult, "operations" | "warnings" | "referencedTypes"> {
  const ctx: Ctx = { doc, warn: new Warnings(), referenced: new Set() };
  if (Array.isArray(doc.servers) && doc.servers.some((s) => isObject(s) && typeof s.url === "string" && s.url !== "/")) {
    ctx.warn.add("Server URLs are not imported; set the API's base path in its settings if the paths need a prefix.");
  }
  if (isObject(doc.webhooks) && Object.keys(doc.webhooks).length > 0) ctx.warn.add("Webhooks are not imported.");
  if (doc.security !== undefined || (isObject(doc.components) && doc.components.securitySchemes !== undefined)) {
    ctx.warn.add("Security schemes and requirements are not imported.");
  }

  const operations: ApiOperation[] = [];
  const names = new Set<string>();
  let skippedForLimit = 0;
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [rawPath, rawItem] of Object.entries(paths)) {
    const pathItem = deref(ctx, rawItem, rawPath);
    if (!pathItem) continue;
    for (const method of OPENAPI_METHODS) {
      const op = pathItem[method];
      if (!isObject(op)) continue;
      if (operations.length >= MAX_IMPORTED_OPERATIONS) {
        skippedForLimit++;
        continue;
      }
      const mapped = mapOperation(ctx, method, rawPath, pathItem, op, names);
      if (!mapped) continue;
      const parsed = parseApiOperation(mapped);
      if (!parsed.success) {
        ctx.warn.add(`${method.toUpperCase()} ${rawPath}: skipped (${formatIssues(parsed.issues)}).`);
        continue;
      }
      const issues = [...checkApiOperation(parsed.data), ...checkAgainstSiblings(parsed.data, operations)];
      if (issues.length) {
        ctx.warn.add(`${method.toUpperCase()} ${rawPath}: skipped (${formatIssues(issues)}).`);
        continue;
      }
      operations.push(parsed.data);
    }
  }
  if (skippedForLimit > 0) {
    ctx.warn.add(`Only the first ${MAX_IMPORTED_OPERATIONS} operations are imported; ${skippedForLimit} more were skipped.`);
  }
  if (Object.keys(paths).length === 0) ctx.warn.add("The document has no paths.");

  // Only the names the kept operations use.
  const used = new Set<string>();
  const primitives: ReadonlySet<string> = new Set(PRIMITIVE_TYPES);
  for (const op of operations) {
    for (const t of [...op.parameters.map((p) => p.type), op.requestBody?.type, ...op.responses.map((r) => r.type)]) {
      if (t && !primitives.has(t) && ctx.referenced.has(t)) used.add(t);
    }
  }
  return { operations, warnings: ctx.warn.done(), referencedTypes: [...used].sort() };
}
