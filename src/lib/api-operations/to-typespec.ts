/**
 * An entity's API operations (the contract in `src/types/schemas/api-operation.ts`) as TypeSpec `@typespec/http` source, so the
 * existing OpenAPI 3 target (`@typespec/openapi3`) emits them as `paths`.
 *
 * Two halves, both pure (no I/O, client-safe):
 * - {@link toApiOperations} / {@link readApiOperations}: THE adapter from whatever an operation row looks like to the contract. It takes
 *   the contract shape itself, the Prisma rows after the Phase A migration (operationId, summary, tags, deprecated, requestBody, isArray,
 *   contentType, sortOrder) and the legacy rows before it (a parameter with `location: "body"` is the request body, `Order[]` is an array,
 *   `GET`/`get` alike). Every reader of operations (emission, actions, the API tab, the OpenAPI import) goes through it.
 * - {@link apiOperationsTypeSpec}: one TypeSpec `interface` holding every operation, with `@route` / `@get`... / `@path` / `@query` /
 *   `@header` / `@cookie` / `@body` / `@statusCode` / `@tag` / `#deprecated` / `@doc` / `@summary` / `@TypeSpec.OpenAPI.operationId`.
 *   A type is a primitive of the contract (mapped to a TypeSpec scalar) or the name of an entity / data type, resolved by the caller
 *   (`resolveNamedType`) because only the caller knows how the name is spelled where the interface is written (bare in a stand-alone
 *   document, namespace-qualified in a closure). A name that does not resolve is typed `unknown` and reported, never written bare (a
 *   bare name that binds to a namespace compiles silently to `{}`).
 *
 * What TypeSpec / OpenAPI cannot hold is skipped with a warning, never a compile error: `OPTIONS` (@typespec/http 1.x has a closed verb set,
 * `HttpVerb` = get | put | post | patch | delete | head, with no decorator or route option for any other verb), a second operation on the
 * same method + path, a path parameter the route has no `{placeholder}` for (http would append it to the path).
 *
 * A `uuid` is a `string` with `@format("uuid")` on the property that carries it. An ARRAY of uuids cannot carry it there (the format would
 * describe the array), so its items are typed by a scalar `<Interface>Uuid extends string` with `@format("uuid")`, declared once beside
 * the interface when an operation needs it (OpenAPI: a `components.schemas` entry `{ type: string, format: uuid }` the items `$ref`).
 */

import {
  PRIMITIVE_TYPES,
  apiOperationSchema,
  type ApiOperation,
  type ApiParameter,
  type ApiResponse,
} from "@/types/schemas/api-operation";
import { tryTypeSpecValueLiteral } from "@/lib/compiler/governance-decorators";
import { escapeString, propertyName, sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { METADATA_ATTRIBUTE_KEY_REGEX } from "@/types/schemas/metadata-attribute";

// ---------------------------------------------------------------------------
// Adapter: rows (legacy or Phase A) / contract objects -> ApiOperation
// ---------------------------------------------------------------------------

/** A parameter row as any reader may hold it: the contract, a Phase A row, or a legacy row (`location: "body"`, `Order[]`). */
export interface ApiParameterRowLike {
  name: string;
  type: string;
  location: string;
  required?: boolean | null;
  description?: string | null;
  isArray?: boolean | null;
  sortOrder?: number | null;
}

/** A response row as any reader may hold it. */
export interface ApiResponseRowLike {
  statusCode: number;
  type?: string | null;
  isArray?: boolean | null;
  contentType?: string | null;
  description?: string | null;
  sortOrder?: number | null;
}

/**
 * An operation as any reader may hold it: the contract (`ApiOperation`), a Prisma `Operation` row with its `parameters` / `responses`
 * included (before or after the Phase A migration), or a mix. Unknown extra columns (`id`, `serviceId`, `decorators`, timestamps) are ignored.
 */
export interface ApiOperationRowLike {
  name: string;
  httpMethod: string;
  httpPath: string;
  operationId?: string | null;
  summary?: string | null;
  description?: string | null;
  /** string[]; a Prisma `Json` column arrives as `unknown`. */
  tags?: unknown;
  deprecated?: boolean | null;
  /** `ApiRequestBody` or null; a Prisma `Json?` column arrives as `unknown`. */
  requestBody?: unknown;
  parameters?: ReadonlyArray<ApiParameterRowLike> | null;
  responses?: ReadonlyArray<ApiResponseRowLike> | null;
  /** A contract operation's attributes (`x-*` -> value). */
  extensions?: unknown;
  /** A Prisma row's `decorators` Json: its `extensions` map holds the attributes. */
  decorators?: unknown;
}

export interface ReadApiOperationsOptions {
  /**
   * The service's base path (`ServiceDefinition.basePath`), prefixed to every `httpPath` (`/v1` + `/orders` = `/v1/orders`). `/` or
   * empty adds nothing. Pass it when an entity's operations come from several services, each with its own base path.
   */
  basePath?: string | null;
}

/** One row that could not be read as a contract operation, and why (the zod issues, joined). */
export interface ApiOperationIssue {
  name: string;
  message: string;
}

/** Spellings legacy rows (and hand-typed types) use for the contract's primitives. Matched case-insensitively; anything else is a name. */
const PRIMITIVE_ALIASES: Readonly<Record<string, (typeof PRIMITIVE_TYPES)[number]>> = {
  string: "string",
  str: "string",
  text: "string",
  int: "int32",
  integer: "int32",
  int32: "int32",
  long: "int64",
  int64: "int64",
  float: "float",
  float32: "float",
  double: "double",
  float64: "double",
  number: "double",
  boolean: "boolean",
  bool: "boolean",
  date: "date",
  plaindate: "date",
  "date-time": "date-time",
  datetime: "date-time",
  utcdatetime: "date-time",
  timestamp: "date-time",
  uuid: "uuid",
  guid: "uuid",
  bytes: "bytes",
  binary: "bytes",
  byte: "bytes",
};

/** `Order[]` -> `{ type: "Order", isArray: true }`; a primitive alias -> its contract name; a name is trimmed and kept as written. */
function normalizeTypeRef(rawType: string, rawIsArray: boolean | null | undefined): { type: string; isArray: boolean } {
  let type = rawType.trim();
  let isArray = rawIsArray === true;
  const listed = /^(?:array<\s*(.+?)\s*>|(.+?)\s*\[\s*\])$/i.exec(type);
  if (listed) {
    type = (listed[1] ?? listed[2]).trim();
    isArray = true;
  }
  return { type: PRIMITIVE_ALIASES[type.toLowerCase()] ?? type, isArray };
}

function joinPath(basePath: string | null | undefined, httpPath: string): string {
  const path = httpPath.trim().startsWith("/") ? httpPath.trim() : `/${httpPath.trim()}`;
  const base = (basePath ?? "").trim().replace(/\/+$/, "");
  if (base === "" || base === "/") return path;
  return `${base.startsWith("/") ? base : `/${base}`}${path === "/" ? "" : path}`;
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];

const bySortOrder = <T extends { sortOrder?: number | null }>(rows: ReadonlyArray<T>): T[] =>
  rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (a.row.sortOrder ?? a.index) - (b.row.sortOrder ?? b.index) || a.index - b.index)
    .map(({ row }) => row);

/** The attribute map of a row: its own `extensions` (a contract operation) or `decorators.extensions`; only keys that follow the attribute key rule. */
function extensionsOf(row: ApiOperationRowLike): Record<string, unknown> | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const fromDecorators = isObj(row.decorators) ? row.decorators.extensions : undefined;
  const map = isObj(row.extensions) ? row.extensions : isObj(fromDecorators) ? fromDecorators : undefined;
  if (!map) return undefined;
  const kept = Object.entries(map).filter(([k, v]) => METADATA_ATTRIBUTE_KEY_REGEX.test(k) && k.length <= 64 && v !== undefined);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The contract-shaped candidate of one row (not validated yet). */
function candidateOf(row: ApiOperationRowLike, opts: ReadApiOperationsOptions): unknown {
  const parameters: unknown[] = [];
  let requestBody: unknown = row.requestBody ?? null;
  for (const p of bySortOrder(row.parameters ?? [])) {
    const ref = normalizeTypeRef(p.type, p.isArray);
    const location = p.location.trim().toLowerCase();
    if (location === "body") {
      // Legacy: the body was a parameter. The first one wins (an operation has one body); a body column always wins over it.
      if (requestBody === null) requestBody = { ...ref, required: p.required ?? true, description: p.description ?? "", contentType: "application/json" };
      continue;
    }
    parameters.push({ ...ref, name: p.name, location, required: location === "path" ? true : (p.required ?? false), description: p.description ?? "" });
  }
  if (requestBody !== null && typeof requestBody === "object" && typeof (requestBody as { type?: unknown }).type === "string") {
    const body = requestBody as { type: string; isArray?: boolean | null };
    requestBody = { ...(requestBody as object), ...normalizeTypeRef(body.type, body.isArray) };
  }
  const responses = bySortOrder(row.responses ?? []).map((r) => {
    const named = typeof r.type === "string" && r.type.trim() !== "" ? normalizeTypeRef(r.type, r.isArray) : null;
    return {
      statusCode: r.statusCode,
      type: named?.type ?? null,
      isArray: named?.isArray ?? false,
      contentType: r.contentType ?? "application/json",
      description: r.description ?? "",
    };
  });
  return {
    name: row.name,
    ...(row.operationId ? { operationId: row.operationId } : {}),
    summary: row.summary ?? "",
    description: row.description ?? "",
    httpMethod: row.httpMethod.trim().toUpperCase(),
    httpPath: joinPath(opts.basePath, row.httpPath),
    tags: stringArray(row.tags),
    deprecated: row.deprecated === true,
    parameters,
    requestBody,
    responses,
    ...(extensionsOf(row) ? { extensions: extensionsOf(row) } : {}),
  };
}

/**
 * Reads operation rows (contract objects, Phase A rows or legacy rows) as contract operations, in input order. A row that is not a
 * valid operation even after normalizing (an unknown method, an empty name, a status code out of range) is left out and listed in
 * `issues`, so one bad row never hides the others.
 */
export function readApiOperations(
  rows: ReadonlyArray<ApiOperationRowLike>,
  opts: ReadApiOperationsOptions = {}
): { operations: ApiOperation[]; issues: ApiOperationIssue[] } {
  const operations: ApiOperation[] = [];
  const issues: ApiOperationIssue[] = [];
  for (const row of rows) {
    const parsed = apiOperationSchema.safeParse(candidateOf(row, opts));
    if (parsed.success) operations.push(parsed.data);
    else issues.push({ name: row.name, message: parsed.error.issues.map((i) => `${i.path.join(".") || "operation"}: ${i.message}`).join("; ") });
  }
  return { operations, issues };
}

/** {@link readApiOperations} without the issues: the operations that are valid, in input order. */
export function toApiOperations(rows: ReadonlyArray<ApiOperationRowLike>, opts: ReadApiOperationsOptions = {}): ApiOperation[] {
  return readApiOperations(rows, opts).operations;
}

// ---------------------------------------------------------------------------
// ApiOperation[] -> TypeSpec
// ---------------------------------------------------------------------------

/** The TypeSpec scalar of each contract primitive (`uuid` is a `string` with `@format("uuid")` where a property carries it, see the module comment). */
const PRIMITIVE_SCALARS: Readonly<Record<(typeof PRIMITIVE_TYPES)[number], string>> = {
  string: "string",
  int32: "int32",
  int64: "int64",
  float: "float32",
  double: "float64",
  boolean: "boolean",
  date: "plainDate",
  "date-time": "utcDateTime",
  uuid: "string",
  bytes: "bytes",
};

/** The TypeSpec scalar of a contract primitive, or undefined for a name (an entity / data type). */
export function primitiveTypeSpecScalar(type: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PRIMITIVE_SCALARS, type) ? PRIMITIVE_SCALARS[type as keyof typeof PRIMITIVE_SCALARS] : undefined;
}

const HTTP_VERB_DECORATORS: Readonly<Record<string, string | undefined>> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  HEAD: "head",
};

export interface ApiOperationsTypeSpecOptions {
  /** The interface's name (a valid, unique identifier in the namespace it is written to). */
  interfaceName: string;
  /**
   * The TypeSpec type of an entity / data-type name used by an operation, as it must be written where the interface sits (a bare
   * model name stand-alone, a namespace-qualified one in a closure); null when the name is not declared in the document.
   */
  resolveNamedType(name: string): string | null;
}

export interface ApiOperationsTypeSpec {
  /**
   * The interface, plus the uuid item scalar when an operation uses an array of uuids, plus a `model` per response that has a description (TypeSpec takes a response's description from its model's
   * `@doc`; an envelope model with `@statusCode` is not emitted as a schema). Top-level declarations, column 0. Empty when no operation
   * could be written.
   */
  lines: string[];
  /** What could not be written as asked (skipped operations / parameters, unresolved types), one sentence each. */
  warnings: string[];
}

/** Path template variables (`/orders/{id}/lines/{lineNo}` -> `id`, `lineNo`), in order, without RFC 6570 operators. */
function pathVariables(path: string): string[] {
  return [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].replace(/^[+#./;?&]/, "").replace(/\*$/, "").trim());
}

/** A fresh identifier from `want`, never one in `taken` (`_2`, `_3`... appended); recorded in `taken`. */
function uniqueIdentifier(want: string, taken: Set<string>, toIdentifier: (s: string) => string = propertyName): string {
  const base = toIdentifier(want);
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = toIdentifier(`${want}_${n}`);
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Writes the operations as one TypeSpec interface (see the module comment). The source needs `@typespec/http` with `using TypeSpec.Http;`
 * (the OpenAPI 3 source has both) and `import "@typespec/openapi";` for `@TypeSpec.OpenAPI.operationId` (written fully qualified, so no
 * `using` is needed).
 */
export function apiOperationsTypeSpec(operations: ReadonlyArray<ApiOperation>, opts: ApiOperationsTypeSpecOptions): ApiOperationsTypeSpec {
  const warnings: string[] = [];
  const ops: string[] = [];
  const responseModels: string[] = [];
  const opNames = new Set<string>();
  const routes = new Set<string>();
  const operationIds = new Set<string>();
  const unresolved = new Set<string>();

  /** The uuid item scalar (see the module comment), named on first use. */
  let uuidScalar: string | null = null;
  /** The TypeSpec type of a type reference; unresolved names are `unknown` (reported once per name). */
  const typeOf = (type: string, isArray: boolean, where: string): string => {
    if (type === "uuid" && isArray) {
      uuidScalar ??= uniqueIdentifier(`${opts.interfaceName}Uuid`, opNames, sanitizeIdentifier);
      return `${uuidScalar}[]`;
    }
    let expr = primitiveTypeSpecScalar(type);
    if (expr === undefined) {
      const resolved = opts.resolveNamedType(type);
      if (resolved === null) {
        if (!unresolved.has(type)) {
          unresolved.add(type);
          warnings.push(`${where}: the type "${type}" is not part of this schema (no entity you can read answers to it unambiguously, and it is not one of this entity's data types), so it is emitted as unknown.`);
        }
        expr = "unknown";
      } else expr = resolved;
    }
    return isArray ? `${expr}[]` : expr;
  };
  /** `@format("uuid") ` for a single uuid (an array's items are the uuid scalar instead: a property's format would describe the array). */
  const formatOf = (type: string | null | undefined, isArray: boolean): string => (type === "uuid" && !isArray ? '@format("uuid") ' : "");
  const doc = (text: string): string => (text.trim() === "" ? "" : `@doc("${escapeString(text)}") `);

  for (const op of operations) {
    const label = `Operation "${op.name}"`;
    const verb = HTTP_VERB_DECORATORS[op.httpMethod];
    if (verb === undefined) {
      warnings.push(
        `${label}: ${op.httpMethod} ${op.httpPath} is not in the OpenAPI document: @typespec/http can only write GET, PUT, POST, PATCH, DELETE and HEAD operations, so the operation is left out.`
      );
      continue;
    }
    const routeKey = `${op.httpMethod} ${op.httpPath.replace(/\{[^{}]+\}/g, "{}")}`;
    if (routes.has(routeKey)) {
      warnings.push(`${label}: another operation already uses ${op.httpMethod} ${op.httpPath}, so this one is left out.`);
      continue;
    }
    routes.add(routeKey);

    const opIdent = uniqueIdentifier(op.name, opNames, sanitizeIdentifier);
    const props = new Set<string>();
    const params: string[] = [];
    const variables = pathVariables(op.httpPath);
    const declaredPath = new Set<string>();

    for (const p of op.parameters as ApiParameter[]) {
      if (p.location === "path") {
        if (!variables.includes(p.name)) {
          warnings.push(`${label}: path parameter "${p.name}" has no {${p.name}} in ${op.httpPath}, so it is left out.`);
          continue;
        }
        if (declaredPath.has(p.name)) continue;
        declaredPath.add(p.name);
      }
      const ident = uniqueIdentifier(p.name, props);
      const name = escapeString(p.name);
      const location =
        p.location === "query" && p.isArray ? `@query(#{ name: "${name}", explode: true })` : `@${p.location}("${name}")`;
      const optional = p.location === "path" || p.required ? "" : "?";
      params.push(`${doc(p.description)}${formatOf(p.type, p.isArray)}${location} ${ident}${optional}: ${typeOf(p.type, p.isArray, label)}`);
    }
    for (const variable of variables) {
      if (declaredPath.has(variable)) continue;
      warnings.push(`${label}: {${variable}} in ${op.httpPath} has no path parameter, so it is emitted as a required string.`);
      declaredPath.add(variable);
      params.push(`@path("${escapeString(variable)}") ${uniqueIdentifier(variable, props)}: string`);
    }
    const userContentType = op.parameters.some((p) => p.location === "header" && p.name.toLowerCase() === "content-type");
    if (op.requestBody) {
      const body = op.requestBody;
      if (!userContentType) params.push(`@header("Content-Type") ${uniqueIdentifier("contentType", props)}: "${escapeString(body.contentType)}"`);
      params.push(`${doc(body.description)}${formatOf(body.type, body.isArray)}@body ${uniqueIdentifier("body", props)}${body.required ? "" : "?"}: ${typeOf(body.type, body.isArray, label)}`);
    }

    // Responses: one per status code (the first wins), each an anonymous envelope, or a named one when it has a description.
    const seenStatus = new Set<number>();
    const variants: string[] = [];
    for (const r of op.responses as ApiResponse[]) {
      if (seenStatus.has(r.statusCode)) {
        warnings.push(`${label}: status ${r.statusCode} is listed twice; only the first response is emitted.`);
        continue;
      }
      seenStatus.add(r.statusCode);
      const members = [`@statusCode _: ${r.statusCode};`];
      if (r.type) {
        members.push(`@header("Content-Type") contentType: "${escapeString(r.contentType)}";`);
        members.push(`${formatOf(r.type, r.isArray)}@body body: ${typeOf(r.type, r.isArray, label)};`);
      }
      if (r.description.trim() !== "") {
        const modelName = uniqueIdentifier(`${opts.interfaceName}_${opIdent}_${r.statusCode}`, opNames, sanitizeIdentifier);
        responseModels.push(`@doc("${escapeString(r.description)}")`, `model ${modelName} {`, ...members.map((m) => `  ${m}`), "}", "");
        variants.push(modelName);
      } else variants.push(`{ ${members.join(" ")} }`);
    }
    const returns = variants.length === 0 ? "void" : variants.join(" | ");

    const operationId = op.operationId?.trim() || op.name;
    const decorators: string[] = [];
    if (op.description.trim() !== "") decorators.push(`@doc("${escapeString(op.description)}")`);
    if (op.summary.trim() !== "") decorators.push(`@summary("${escapeString(op.summary)}")`);
    for (const tag of op.tags) decorators.push(`@tag("${escapeString(tag)}")`);
    if (operationIds.has(operationId)) {
      warnings.push(`${label}: operationId "${operationId}" is already used, so this operation gets the generated one.`);
    } else {
      operationIds.add(operationId);
      decorators.push(`@TypeSpec.OpenAPI.operationId("${escapeString(operationId)}")`);
    }
    if (op.deprecated) decorators.push('#deprecated "This operation is deprecated."');
    for (const [key, value] of Object.entries(op.extensions ?? {})) {
      const literal = tryTypeSpecValueLiteral(value);
      if (literal === undefined) continue; // nested past the literal depth limit: omit the key rather than truncate
      decorators.push(`@TypeSpec.OpenAPI.extension("${escapeString(key)}", ${literal})`);
    }
    decorators.push(`@route("${escapeString(op.httpPath)}")`, `@${verb}`);

    ops.push(...decorators, `op ${opIdent}(${params.join(", ")}): ${returns};`, "");
  }

  if (ops.length === 0) return { lines: [], warnings };
  while (ops[ops.length - 1] === "") ops.pop();
  while (responseModels[responseModels.length - 1] === "") responseModels.pop();
  const scalar = uuidScalar === null ? [] : ['@format("uuid")', `scalar ${uuidScalar} extends string;`];
  const declarations = scalar.length > 0 && responseModels.length > 0 ? [...scalar, "", ...responseModels] : [...scalar, ...responseModels];
  const lines = [`interface ${opts.interfaceName} {`, ...ops.map((l) => (l === "" ? "" : `  ${l}`)), "}"];
  return { lines: declarations.length > 0 ? [...declarations, "", ...lines] : lines, warnings };
}
