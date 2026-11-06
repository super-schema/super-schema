import { validate as validateOpenApi } from "@scalar/openapi-parser";
import type { OpenAPIV3_1 } from "openapi-types";
import type { z } from "zod";

import {
  apiOperationSchema,
  LEGACY_BODY_LOCATION,
  PRIMITIVE_TYPES,
  type ApiOperation,
  type ApiParameter,
} from "@/types/schemas/api-operation";

/**
 * Validation of API operations (the `api-operation.ts` contract): zod shape, then the rules zod cannot express (duplicate
 * method + path / operationId within a service, `{placeholders}` vs path parameters, identifier-valid names, unique status
 * codes), then a minimal OpenAPI 3.1 document of the operations checked by `@scalar/openapi-parser`.
 */

export interface ApiOperationIssue {
  /** Dotted location in the operation payload (`httpPath`, `parameters.0.name`, ...); "" for the payload itself. */
  path: string;
  message: string;
}

export type ApiOperationParse = { success: true; data: ApiOperation } | { success: false; issues: ApiOperationIssue[] };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 token: what an HTTP header name may be. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+*-]+$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const PRIMITIVES: ReadonlySet<string> = new Set(PRIMITIVE_TYPES);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Lift legacy `location: "body"` parameters out of a raw payload: the first becomes `requestBody` (unless one is given),
 * the rest are dropped. Anything else is returned untouched for zod to judge.
 */
export function liftLegacyBodyParameters(raw: unknown): unknown {
  if (!isObject(raw) || !Array.isArray(raw.parameters)) return raw;
  const isBody = (p: unknown) => isObject(p) && p.location === LEGACY_BODY_LOCATION;
  const body = raw.parameters.filter(isBody) as Record<string, unknown>[];
  if (body.length === 0) return raw;
  const first = body[0];
  const requestBody =
    raw.requestBody ??
    {
      type: first.type,
      isArray: first.isArray ?? false,
      required: first.required ?? true,
      description: first.description ?? "",
    };
  return { ...raw, parameters: raw.parameters.filter((p) => !isBody(p)), requestBody };
}

/** Readable zod messages: never zod's "received undefined" (it reads like a leaked internal). */
const errorMap = (issue: z.core.$ZodRawIssue): string | undefined => {
  if (issue.input === undefined && (issue.code === "invalid_type" || issue.code === "invalid_value")) return "is required";
  switch (issue.code) {
    case "invalid_type":
      return issue.expected === "array" ? "must be a list" : `must be a ${issue.expected}`;
    case "invalid_value":
      return `must be one of ${issue.values.map(String).join(", ")}`;
    case "invalid_format":
      return issue.format === "starts_with" ? `must start with "${(issue as { prefix?: string }).prefix ?? "/"}"` : "has an invalid format";
    case "too_small":
      return issue.origin === "string" ? "must not be empty" : `must be at least ${String(issue.minimum)}`;
    case "too_big":
      return `must be at most ${String(issue.maximum)}`;
    default:
      return undefined;
  }
};

const issuePath = (path: PropertyKey[]) => path.map(String).join(".");
const issueText = (i: ApiOperationIssue) => (i.path ? `${i.path} ${i.message}` : i.message);

/** One line for a toast: the first few issues. */
export function formatIssues(issues: ApiOperationIssue[], max = 3): string {
  const shown = issues.slice(0, max).map(issueText).join("; ");
  return issues.length > max ? `${shown} (and ${issues.length - max} more)` : shown;
}

/**
 * zod-parse one operation (legacy body parameters lifted, method upper-cased) and normalize it: trimmed name / operationId /
 * tags, an empty operationId dropped, path parameters always required (OpenAPI demands it).
 */
export function parseApiOperation(raw: unknown): ApiOperationParse {
  let input = liftLegacyBodyParameters(raw);
  if (isObject(input) && typeof input.httpMethod === "string") input = { ...input, httpMethod: input.httpMethod.trim().toUpperCase() };
  if (isObject(input) && typeof input.httpPath === "string") input = { ...input, httpPath: input.httpPath.trim() };
  const parsed = apiOperationSchema.safeParse(input, { error: errorMap });
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })),
    };
  }
  const op = parsed.data;
  const operationId = op.operationId?.trim();
  return {
    success: true,
    data: {
      ...op,
      name: op.name.trim(),
      operationId: operationId ? operationId : undefined,
      tags: [...new Set(op.tags.map((t) => t.trim()).filter(Boolean))],
      parameters: op.parameters.map((p) => ({ ...p, name: p.name.trim(), required: p.location === "path" ? true : p.required })),
    },
  };
}

/** `{placeholder}` names of a path, in order. */
export function pathPlaceholders(httpPath: string): string[] {
  return [...httpPath.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/** A path with its placeholders anonymized and no trailing slash: two operations on the same template collide. */
export function pathTemplateKey(httpPath: string): string {
  return stripTrailingSlash(httpPath.replace(PLACEHOLDER, "{}"));
}

const stripTrailingSlash = (path: string) => path.replace(/\/+$/, "") || "/";

const effectiveOperationId = (op: ApiOperation) => op.operationId ?? op.name;

function checkTypeName(type: string, path: string, issues: ApiOperationIssue[]) {
  if (!PRIMITIVES.has(type) && !TYPE_NAME.test(type)) {
    issues.push({ path, message: `"${type}" is not a primitive type or a valid type name` });
  }
}

function checkParameterName(p: ApiParameter, path: string, issues: ApiOperationIssue[]) {
  const valid = p.location === "header" ? HEADER_TOKEN.test(p.name) : IDENTIFIER.test(p.name);
  if (!valid) {
    issues.push({
      path,
      message:
        p.location === "header"
          ? `"${p.name}" is not a valid header name`
          : `"${p.name}" must be an identifier (letters, digits and _, not starting with a digit)`,
    });
  }
}

/** The rules of one operation on its own (no siblings). */
export function checkApiOperation(op: ApiOperation): ApiOperationIssue[] {
  const issues: ApiOperationIssue[] = [];
  if (!IDENTIFIER.test(op.name)) {
    issues.push({ path: "name", message: `"${op.name}" must be an identifier (letters, digits and _, not starting with a digit)` });
  }
  if (op.operationId !== undefined && !IDENTIFIER.test(op.operationId)) {
    issues.push({ path: "operationId", message: `"${op.operationId}" must be an identifier` });
  }

  // Path syntax: no query / fragment / whitespace, balanced and identifier-named placeholders, each once.
  if (/[\s?#]/.test(op.httpPath)) issues.push({ path: "httpPath", message: "must not contain spaces, ? or #" });
  if (/[{}]/.test(op.httpPath.replace(PLACEHOLDER, ""))) issues.push({ path: "httpPath", message: "has an unbalanced { or }" });
  const placeholders = pathPlaceholders(op.httpPath);
  const seenPlaceholders = new Set<string>();
  for (const name of placeholders) {
    if (!IDENTIFIER.test(name)) issues.push({ path: "httpPath", message: `path parameter "{${name}}" must be an identifier` });
    if (seenPlaceholders.has(name)) issues.push({ path: "httpPath", message: `path parameter "{${name}}" appears more than once` });
    seenPlaceholders.add(name);
  }

  const seenParams = new Set<string>();
  op.parameters.forEach((p, i) => {
    checkParameterName(p, `parameters.${i}.name`, issues);
    checkTypeName(p.type, `parameters.${i}.type`, issues);
    const key = `${p.location}:${p.location === "header" ? p.name.toLowerCase() : p.name}`;
    if (seenParams.has(key)) issues.push({ path: `parameters.${i}.name`, message: `duplicate ${p.location} parameter "${p.name}"` });
    seenParams.add(key);
    if (p.location === "path" && !seenPlaceholders.has(p.name)) {
      issues.push({ path: `parameters.${i}.name`, message: `path parameter "${p.name}" does not appear in the path as {${p.name}}` });
    }
  });
  const pathParams = new Set(op.parameters.filter((p) => p.location === "path").map((p) => p.name));
  for (const name of seenPlaceholders) {
    if (!pathParams.has(name)) issues.push({ path: "parameters", message: `{${name}} in the path has no path parameter` });
  }

  if (op.requestBody) {
    checkTypeName(op.requestBody.type, "requestBody.type", issues);
    if (!MEDIA_TYPE.test(op.requestBody.contentType)) {
      issues.push({ path: "requestBody.contentType", message: `"${op.requestBody.contentType}" is not a media type` });
    }
  }

  const seenStatus = new Set<number>();
  op.responses.forEach((r, i) => {
    if (seenStatus.has(r.statusCode)) issues.push({ path: `responses.${i}.statusCode`, message: `duplicate status code ${r.statusCode}` });
    seenStatus.add(r.statusCode);
    if (r.type) {
      checkTypeName(r.type, `responses.${i}.type`, issues);
      if (!MEDIA_TYPE.test(r.contentType)) {
        issues.push({ path: `responses.${i}.contentType`, message: `"${r.contentType}" is not a media type` });
      }
    }
  });
  return issues;
}

/**
 * What an operation may be stored with but will not reach the generated OpenAPI document as written. Today: an `OPTIONS` operation
 * (the contract and an OpenAPI document allow it, but `@typespec/http` 1.x, which writes the OpenAPI 3 output, has a closed verb set
 * without OPTIONS, so generation leaves it out and says so). Warnings never block a save.
 */
export function apiOperationWarnings(op: ApiOperation): ApiOperationIssue[] {
  const warnings: ApiOperationIssue[] = [];
  if (op.httpMethod === "OPTIONS") {
    warnings.push({
      path: "httpMethod",
      message: "OPTIONS operations are stored but left out of the generated OpenAPI document (TypeSpec HTTP can only write GET, PUT, POST, PATCH, DELETE and HEAD)",
    });
  }
  return warnings;
}

/** {@link apiOperationWarnings} of every operation of a service, prefixed `operations.<i>.` like {@link checkServiceOperations}. */
export function serviceOperationWarnings(ops: ApiOperation[]): ApiOperationIssue[] {
  return ops.flatMap((op, i) => apiOperationWarnings(op).map((w) => ({ path: w.path ? `operations.${i}.${w.path}` : `operations.${i}`, message: w.message })));
}

/**
 * `op` against the other operations of its service: one operation per method + path template, one path template per
 * spelling (OpenAPI treats `/a/{id}` and `/a/{key}` as the same path), unique operationIds.
 */
export function checkAgainstSiblings(op: ApiOperation, siblings: ApiOperation[]): ApiOperationIssue[] {
  const issues: ApiOperationIssue[] = [];
  const key = pathTemplateKey(op.httpPath);
  const spelled = stripTrailingSlash(op.httpPath);
  for (const s of siblings) {
    const sKey = pathTemplateKey(s.httpPath);
    if (sKey !== key) continue;
    if (s.httpMethod === op.httpMethod) {
      issues.push({ path: "httpPath", message: `${op.httpMethod} ${op.httpPath} is already defined by "${s.name}"` });
      continue;
    }
    if (stripTrailingSlash(s.httpPath) !== spelled) {
      issues.push({ path: "httpPath", message: `${op.httpPath} names its path parameters differently from ${s.httpPath} ("${s.name}")` });
    }
  }
  const id = effectiveOperationId(op);
  const clash = siblings.find((s) => effectiveOperationId(s) === id);
  if (clash) {
    issues.push({ path: op.operationId ? "operationId" : "name", message: `operationId "${id}" is already used by "${clash.name}"` });
  }
  return issues;
}

/** Every rule over a whole service: each operation alone, then each against the ones before it. */
export function checkServiceOperations(ops: ApiOperation[]): ApiOperationIssue[] {
  const issues: ApiOperationIssue[] = [];
  ops.forEach((op, i) => {
    const prefix = (path: string) => (path ? `operations.${i}.${path}` : `operations.${i}`);
    for (const issue of [...checkApiOperation(op), ...checkAgainstSiblings(op, ops.slice(0, i))]) {
      issues.push({ path: prefix(issue.path), message: issue.message });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Minimal OpenAPI 3.1 document
// ---------------------------------------------------------------------------

type Schema = OpenAPIV3_1.SchemaObject | OpenAPIV3_1.ReferenceObject;

const PRIMITIVE_SCHEMAS: Record<(typeof PRIMITIVE_TYPES)[number], OpenAPIV3_1.SchemaObject> = {
  string: { type: "string" },
  int32: { type: "integer", format: "int32" },
  int64: { type: "integer", format: "int64" },
  float: { type: "number", format: "float" },
  double: { type: "number", format: "double" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" },
  "date-time": { type: "string", format: "date-time" },
  uuid: { type: "string", format: "uuid" },
  bytes: { type: "string", contentEncoding: "base64" } as OpenAPIV3_1.SchemaObject,
};

function typeSchema(type: string, isArray: boolean, named: Set<string>): Schema {
  let schema: Schema;
  if (PRIMITIVES.has(type)) {
    schema = { ...PRIMITIVE_SCHEMAS[type as keyof typeof PRIMITIVE_SCHEMAS] };
  } else {
    named.add(type);
    schema = { $ref: `#/components/schemas/${type}` };
  }
  return isArray ? { type: "array", items: schema } : schema;
}

function joinPath(basePath: string | undefined, httpPath: string): string {
  const base = (basePath ?? "").replace(/\/+$/, "");
  return base && base !== "/" ? `${base.startsWith("/") ? base : `/${base}`}${httpPath}` : httpPath;
}

export interface OpenApiDocumentOptions {
  title?: string;
  version?: string;
  /** Prefixed to every operation path (a service's basePath). */
  basePath?: string;
}

/**
 * The operations as a minimal OpenAPI 3.1 document: entity / data-type names become placeholder object schemas under
 * `components.schemas`, so the document is self-contained. Not the emitted document (that is TypeSpec's job); just enough
 * structure for `@scalar/openapi-parser` to judge the operations.
 */
export function toOpenApiDocument(ops: ApiOperation[], options: OpenApiDocumentOptions = {}): OpenAPIV3_1.Document {
  const named = new Set<string>();
  const paths: Record<string, Record<string, OpenAPIV3_1.OperationObject>> = {};
  for (const op of ops) {
    const operation: OpenAPIV3_1.OperationObject = { operationId: effectiveOperationId(op) };
    if (op.summary) operation.summary = op.summary;
    if (op.description) operation.description = op.description;
    if (op.tags.length) operation.tags = op.tags;
    if (op.deprecated) operation.deprecated = true;
    if (op.parameters.length) {
      operation.parameters = op.parameters.map((p) => ({
        name: p.name,
        in: p.location,
        required: p.location === "path" ? true : p.required,
        ...(p.description ? { description: p.description } : {}),
        schema: typeSchema(p.type, p.isArray, named),
      })) as unknown as OpenAPIV3_1.ParameterObject[]; // openapi-types' 3.1 ParameterObject still types `schema` as 3.0
    }
    if (op.requestBody) {
      operation.requestBody = {
        required: op.requestBody.required,
        ...(op.requestBody.description ? { description: op.requestBody.description } : {}),
        content: { [op.requestBody.contentType]: { schema: typeSchema(op.requestBody.type, op.requestBody.isArray, named) } },
      };
    }
    if (op.responses.length) {
      operation.responses = Object.fromEntries(
        op.responses.map((r) => [
          String(r.statusCode),
          {
            description: r.description || `${r.statusCode} response`,
            ...(r.type ? { content: { [r.contentType]: { schema: typeSchema(r.type, r.isArray, named) } } } : {}),
          },
        ])
      );
    }
    const key = joinPath(options.basePath, op.httpPath);
    (paths[key] ??= {})[op.httpMethod.toLowerCase()] = operation;
  }
  const doc: OpenAPIV3_1.Document = {
    openapi: "3.1.0",
    info: { title: options.title ?? "API", version: options.version ?? "0.0.0" },
    paths: paths as OpenAPIV3_1.PathsObject,
  };
  if (named.size) {
    doc.components = { schemas: Object.fromEntries([...named].sort().map((n) => [n, { type: "object" }])) };
  }
  return doc;
}

/** ajv's combinator noise ("if must match else schema", "must match exactly one schema in oneOf"); the specific error follows it. */
const NOISE = /^if must match|^must match "(then|else)" schema|^must match exactly one schema in oneOf/;

/** Run `@scalar/openapi-parser`'s `validate` on a document; the issues it reports (empty = valid). */
export async function validateOpenApiDocument(doc: object): Promise<ApiOperationIssue[]> {
  try {
    const result = await validateOpenApi(doc as Record<string, unknown>);
    if (result.valid) return [];
    const errors = result.errors ?? [];
    const specific = errors.filter((e) => !NOISE.test(e.message));
    const shown = specific.length ? specific : errors.slice(0, 1);
    const issues = shown.map((e) => ({
      path: Array.isArray(e.path) ? e.path.join("/") : String(e.path ?? ""),
      message: `OpenAPI: ${e.message}`,
    }));
    return issues.length ? issues : [{ path: "", message: "OpenAPI: the document is not valid" }];
  } catch (e: unknown) {
    return [{ path: "", message: `OpenAPI validation failed: ${e instanceof Error ? e.message : String(e)}` }];
  }
}

export type ApiOperationValidation =
  /** `warnings`: what the operation is stored with but will not be generated as (see {@link apiOperationWarnings}); empty when none. */
  | { valid: true; operation: ApiOperation; warnings: ApiOperationIssue[] }
  | { valid: false; issues: ApiOperationIssue[] };

/**
 * Everything one operation must pass before it is stored: zod + its own rules + its siblings (the other operations of its
 * service, already stored) + `@scalar/openapi-parser` on a one-operation document.
 */
export async function validateApiOperation(raw: unknown, siblings: ApiOperation[] = []): Promise<ApiOperationValidation> {
  const parsed = parseApiOperation(raw);
  if (!parsed.success) return { valid: false, issues: parsed.issues };
  const issues = [...checkApiOperation(parsed.data), ...checkAgainstSiblings(parsed.data, siblings)];
  if (issues.length) return { valid: false, issues };
  const openApi = await validateOpenApiDocument(toOpenApiDocument([parsed.data]));
  return openApi.length ? { valid: false, issues: openApi } : { valid: true, operation: parsed.data, warnings: apiOperationWarnings(parsed.data) };
}

export type ApiOperationsValidation =
  /** `warnings`: see {@link serviceOperationWarnings}; empty when none. */
  | { valid: true; operations: ApiOperation[]; document: OpenAPIV3_1.Document; warnings: ApiOperationIssue[] }
  | { valid: false; issues: ApiOperationIssue[] };

/** A whole service's operations (an import, a generated CRUD set): zod, every rule, then `@scalar/openapi-parser`. */
export async function validateApiOperations(raw: unknown[], options: OpenApiDocumentOptions = {}): Promise<ApiOperationsValidation> {
  const issues: ApiOperationIssue[] = [];
  const operations: ApiOperation[] = [];
  raw.forEach((r, i) => {
    const parsed = parseApiOperation(r);
    if (parsed.success) operations.push(parsed.data);
    else for (const issue of parsed.issues) issues.push({ path: issue.path ? `operations.${i}.${issue.path}` : `operations.${i}`, message: issue.message });
  });
  if (issues.length) return { valid: false, issues };
  const ruleIssues = checkServiceOperations(operations);
  if (ruleIssues.length) return { valid: false, issues: ruleIssues };
  const document = toOpenApiDocument(operations, options);
  const openApi = await validateOpenApiDocument(document);
  return openApi.length ? { valid: false, issues: openApi } : { valid: true, operations, document, warnings: serviceOperationWarnings(operations) };
}
