import {
  PRIMITIVE_TYPES,
  type ApiOperation,
  type ApiOperationRecord,
  type ApiParameter,
} from "@/types/schemas/api-operation";
import {
  apiOperationWarnings,
  checkApiOperation,
  parseApiOperation,
  pathPlaceholders,
  pathTemplateKey,
  type ApiOperationIssue,
} from "@/lib/api-operations/validate";

/**
 * Pure model of the entity API tab: drafts in the contract shape (`ApiOperationRecord`), their client-side validation (the
 * contract's zod schema + the operation rules the server applies), path-parameter sync, CRUD templates and duplicates.
 * Nothing here touches React or the server.
 */

export type OperationDraft = ApiOperationRecord;

/** Every IANA-registered HTTP status code (RFC 9110 and friends), for the response status picker. */
export const HTTP_STATUS_CODES: ReadonlyArray<{ code: number; label: string }> = [
  { code: 100, label: "Continue" },
  { code: 101, label: "Switching Protocols" },
  { code: 102, label: "Processing" },
  { code: 103, label: "Early Hints" },
  { code: 200, label: "OK" },
  { code: 201, label: "Created" },
  { code: 202, label: "Accepted" },
  { code: 203, label: "Non-Authoritative Information" },
  { code: 204, label: "No Content" },
  { code: 205, label: "Reset Content" },
  { code: 206, label: "Partial Content" },
  { code: 207, label: "Multi-Status" },
  { code: 208, label: "Already Reported" },
  { code: 226, label: "IM Used" },
  { code: 300, label: "Multiple Choices" },
  { code: 301, label: "Moved Permanently" },
  { code: 302, label: "Found" },
  { code: 303, label: "See Other" },
  { code: 304, label: "Not Modified" },
  { code: 305, label: "Use Proxy" },
  { code: 307, label: "Temporary Redirect" },
  { code: 308, label: "Permanent Redirect" },
  { code: 400, label: "Bad Request" },
  { code: 401, label: "Unauthorized" },
  { code: 402, label: "Payment Required" },
  { code: 403, label: "Forbidden" },
  { code: 404, label: "Not Found" },
  { code: 405, label: "Method Not Allowed" },
  { code: 406, label: "Not Acceptable" },
  { code: 407, label: "Proxy Authentication Required" },
  { code: 408, label: "Request Timeout" },
  { code: 409, label: "Conflict" },
  { code: 410, label: "Gone" },
  { code: 411, label: "Length Required" },
  { code: 412, label: "Precondition Failed" },
  { code: 413, label: "Content Too Large" },
  { code: 414, label: "URI Too Long" },
  { code: 415, label: "Unsupported Media Type" },
  { code: 416, label: "Range Not Satisfiable" },
  { code: 417, label: "Expectation Failed" },
  { code: 418, label: "I'm a teapot" },
  { code: 421, label: "Misdirected Request" },
  { code: 422, label: "Unprocessable Content" },
  { code: 423, label: "Locked" },
  { code: 424, label: "Failed Dependency" },
  { code: 425, label: "Too Early" },
  { code: 426, label: "Upgrade Required" },
  { code: 428, label: "Precondition Required" },
  { code: 429, label: "Too Many Requests" },
  { code: 431, label: "Request Header Fields Too Large" },
  { code: 451, label: "Unavailable For Legal Reasons" },
  { code: 500, label: "Internal Server Error" },
  { code: 501, label: "Not Implemented" },
  { code: 502, label: "Bad Gateway" },
  { code: 503, label: "Service Unavailable" },
  { code: 504, label: "Gateway Timeout" },
  { code: 505, label: "HTTP Version Not Supported" },
  { code: 506, label: "Variant Also Negotiates" },
  { code: 507, label: "Insufficient Storage" },
  { code: 508, label: "Loop Detected" },
  { code: 510, label: "Not Extended" },
  { code: 511, label: "Network Authentication Required" },
];

/** Suggestions for the content-type inputs (any media type may be typed). */
export const COMMON_CONTENT_TYPES = [
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "text/csv",
  "application/octet-stream",
] as const;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIMITIVES: ReadonlySet<string> = new Set(PRIMITIVE_TYPES);

export const isPrimitiveType = (type: string) => PRIMITIVES.has(type);

/** The collection path suggested for an entity: its name, lower-cased, plural (`Invoice` -> `/invoices`). */
export function collectionPath(entityName: string): string {
  return `/${entityName.toLowerCase()}s`;
}

/** The contract operation of a draft (ids dropped, a blank operationId omitted). */
export function draftToOperation(draft: OperationDraft): ApiOperation {
  const op: Partial<OperationDraft> = { ...draft };
  delete op.id;
  delete op.serviceId;
  const operationId = draft.operationId?.trim();
  if (!operationId) delete op.operationId;
  return op as ApiOperation;
}

/** A stored record from what a create returned. */
export function recordFromOperation(id: string, serviceId: string, op: ApiOperation): OperationDraft {
  return { ...op, id, serviceId, responses: op.responses.map((r) => ({ ...r, type: r.type ?? null })) };
}

/**
 * Every issue the server would raise for this draft on its own and against its siblings (duplicate method + path,
 * duplicate operationId): the contract's zod schema, then the operation rules. Same `path` format as the server's `issues[]`.
 */
export function validateDraft(draft: OperationDraft, siblings: readonly OperationDraft[] = []): ApiOperationIssue[] {
  const parsed = parseApiOperation(draftToOperation(draft));
  if (!parsed.success) return parsed.issues;
  const issues = checkApiOperation(parsed.data);
  const op = parsed.data;
  const template = pathTemplateKey(op.httpPath);
  const key = `${op.httpMethod} ${template}`;
  const spelled = withoutTrailingSlash(op.httpPath);
  const opId = op.operationId ?? op.name;
  for (const s of siblings) {
    if (s.id === draft.id) continue;
    if (`${s.httpMethod.toUpperCase()} ${pathTemplateKey(s.httpPath)}` === key) {
      issues.push({ path: "httpPath", message: `${op.httpMethod} ${op.httpPath} is already defined by "${s.name}"` });
    } else if (pathTemplateKey(s.httpPath) === template && withoutTrailingSlash(s.httpPath) !== spelled) {
      // OpenAPI reads `/a/{id}` and `/a/{key}` as one path: the server refuses two spellings of it (`checkAgainstSiblings`).
      issues.push({ path: "httpPath", message: `${op.httpPath} names its path parameters differently from ${s.httpPath} ("${s.name}")` });
    }
    if ((s.operationId?.trim() || s.name) === opId) {
      issues.push({ path: op.operationId ? "operationId" : "name", message: `operationId "${opId}" is already used by another operation` });
    }
  }
  return issues;
}

/**
 * What the server would warn about when saving this draft (it is stored, but not generated as written; e.g. OPTIONS), as
 * display text. Known before any save, so a stored OPTIONS operation shows its notice on load too.
 */
export function draftWarnings(draft: OperationDraft): string[] {
  return apiOperationWarnings(draftToOperation(draft)).map((w) => w.message);
}

/** `a` then the messages of `b` not already in `a`; `a` itself (same reference) when `b` adds nothing. */
export function mergeWarnings(a: readonly string[], b: readonly string[] | undefined): readonly string[] {
  const extra = (b ?? []).filter((m) => !a.includes(m));
  return extra.length ? [...a, ...extra] : a;
}

const withoutTrailingSlash = (path: string) => path.replace(/\/+$/, "") || "/";

/** First message per issue path. */
export function issuesByPath(issues: readonly ApiOperationIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) if (!(i.path in out)) out[i.path] = i.message;
  return out;
}

/** Issue paths the editor shows next to a control; any other path is listed at the top of the editor. */
const PLACED_PATH = /^(name|operationId|httpMethod|httpPath|summary|description|tags(\.\d+)?|parameters(\.\d+\.(name|type|isArray|location|required|description))?|requestBody(\.(type|isArray|contentType|required|description))?|responses(\.\d+\.(statusCode|type|isArray|contentType|description))?)$/;

export const isPlacedIssuePath = (path: string) => PLACED_PATH.test(path);

/** Placeholder names when the path is well-formed enough to sync from (balanced braces, identifier names); else null. */
function syncablePlaceholders(path: string): string[] | null {
  if (/[{}]/.test(path.replace(/\{[^{}]*\}/g, ""))) return null;
  const names = pathPlaceholders(path);
  if (names.some((n) => !IDENTIFIER.test(n))) return null;
  return [...new Set(names)];
}

/**
 * Path parameters following the path's `{placeholders}`: a new placeholder adds a required string path parameter, a removed
 * one drops its parameter, and a placeholder renamed in place (same position, old name gone, new name new) keeps the
 * parameter's type and description. Non-path parameters are untouched. While the path is mid-edit (unbalanced braces, an
 * empty or non-identifier placeholder) the parameters are left as they are.
 */
export function syncPathParameters(parameters: readonly ApiParameter[], oldPath: string, newPath: string): ApiParameter[] {
  const next = syncablePlaceholders(newPath);
  if (!next) return [...parameters];
  const previous = syncablePlaceholders(oldPath) ?? [];
  const byName = new Map(parameters.filter((p) => p.location === "path").map((p) => [p.name, p]));

  const pathParams: ApiParameter[] = next.map((name, i) => {
    const existing = byName.get(name);
    if (existing) return existing;
    const renamedFrom = previous[i];
    const renamed = renamedFrom !== undefined && !next.includes(renamedFrom) ? byName.get(renamedFrom) : undefined;
    if (renamed) return { ...renamed, name };
    return { name, type: "string", isArray: false, location: "path", required: true, description: "" };
  });

  // Keep the parameters' relative order: path parameters first (in path order), the rest as they were.
  return [...pathParams, ...parameters.filter((p) => p.location !== "path")];
}

/** True when the sync would change the parameter list (avoids a needless edit). */
export function sameParameters(a: readonly ApiParameter[], b: readonly ApiParameter[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** The status code a new response row starts at: the first common code not yet used. */
export function nextStatusCode(used: readonly number[]): number {
  return [200, 201, 204, 400, 401, 403, 404, 409, 422, 500].find((c) => !used.includes(c))
    ?? HTTP_STATUS_CODES.find((s) => !used.includes(s.code))?.code
    ?? 200;
}

export interface CrudKey {
  /** Path parameter name of the entity id. */
  name: string;
  /** Its type (a primitive). */
  type: string;
}

/** The id path parameter for CRUD: the entity's key field when it has a usable one, else `id: string`. */
export function crudKey(fields: ReadonlyArray<{ name: string; type: string; isKey?: boolean }>): CrudKey {
  const key = fields.find((f) => f.isKey && IDENTIFIER.test(f.name));
  if (!key) return { name: "id", type: "string" };
  return { name: key.name, type: isPrimitiveType(key.type) ? key.type : "string" };
}

const pascal = (s: string) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _sep, c: string) => c.toUpperCase());

/** list / get / create / update / delete for one entity, in the contract shape. */
export function crudOperations(entityName: string, key: CrudKey): ApiOperation[] {
  const entity = pascal(entityName) || "Item";
  const base = collectionPath(entityName);
  const item = `${base}/{${key.name}}`;
  const idParam: ApiParameter = { name: key.name, type: key.type, isArray: false, location: "path", required: true, description: `${entity} identifier` };
  const body = { type: entityName, isArray: false, contentType: "application/json", required: true, description: "" };
  const res = (statusCode: number, description: string, type: string | null = null, isArray = false) => ({
    statusCode, type, isArray, contentType: "application/json", description,
  });
  const common = { summary: "", tags: [] as string[], deprecated: false, requestBody: null };
  return [
    { ...common, name: `list${entity}s`, description: `List ${entity} records`, httpMethod: "GET", httpPath: base, parameters: [], responses: [res(200, "Successful response", entityName, true)] },
    { ...common, name: `get${entity}`, description: `Get one ${entity}`, httpMethod: "GET", httpPath: item, parameters: [idParam], responses: [res(200, "Successful response", entityName), res(404, "Not found")] },
    { ...common, name: `create${entity}`, description: `Create a ${entity}`, httpMethod: "POST", httpPath: base, parameters: [], requestBody: body, responses: [res(201, "Created", entityName), res(400, "Invalid request")] },
    { ...common, name: `update${entity}`, description: `Replace a ${entity}`, httpMethod: "PUT", httpPath: item, parameters: [idParam], requestBody: body, responses: [res(200, "Successful response", entityName), res(404, "Not found")] },
    { ...common, name: `delete${entity}`, description: `Delete a ${entity}`, httpMethod: "DELETE", httpPath: item, parameters: [idParam], responses: [res(204, "Deleted"), res(404, "Not found")] },
  ];
}

/** The CRUD operations not yet present: an existing method + path template, or an existing name / operationId, skips one. */
export function missingCrudOperations(existing: readonly OperationDraft[], crud: readonly ApiOperation[]): ApiOperation[] {
  const routes = new Set(existing.map((o) => `${o.httpMethod.toUpperCase()} ${pathTemplateKey(o.httpPath)}`));
  const names = new Set(existing.flatMap((o) => [o.name, o.operationId?.trim()].filter(Boolean) as string[]));
  return crud
    .filter((op) => !routes.has(`${op.httpMethod} ${pathTemplateKey(op.httpPath)}`) && !names.has(op.name))
    .map((op) => adoptExistingSpelling(op, existing));
}

/**
 * `op` on the path spelling an existing operation already uses for the same template (`/invoices/{id}` when the template op
 * says `/invoices/{invoiceId}`), its path parameters renamed by position: OpenAPI reads both as one path, and the server
 * refuses a second spelling of it. Unchanged when no existing operation shares the template.
 */
function adoptExistingSpelling(op: ApiOperation, existing: readonly OperationDraft[]): ApiOperation {
  const template = pathTemplateKey(op.httpPath);
  const twin = existing.find((o) => pathTemplateKey(o.httpPath) === template);
  if (!twin) return op;
  const httpPath = withoutTrailingSlash(twin.httpPath);
  if (httpPath === withoutTrailingSlash(op.httpPath)) return op;
  const from = pathPlaceholders(op.httpPath);
  const to = pathPlaceholders(httpPath);
  const rename = new Map(from.map((name, i) => [name, to[i] ?? name]));
  return {
    ...op,
    httpPath,
    parameters: op.parameters.map((p) => (p.location === "path" && rename.has(p.name) ? { ...p, name: rename.get(p.name)! } : p)),
  };
}

/**
 * A copy of an operation that can be stored next to it: a fresh name (`fooCopy`, `fooCopy2`, ...), no operationId, and a
 * path that does not collide with any sibling on the same method (`/x/copy`, `/x/copy2`, ...).
 */
export function duplicateOperation(source: OperationDraft, existing: readonly OperationDraft[]): ApiOperation {
  const op = draftToOperation(source);
  const names = new Set(existing.flatMap((o) => [o.name, o.operationId?.trim()].filter(Boolean) as string[]));
  let name = `${source.name}Copy`;
  for (let n = 2; names.has(name); n++) name = `${source.name}Copy${n}`;
  const routes = new Set(existing.map((o) => `${o.httpMethod.toUpperCase()} ${pathTemplateKey(o.httpPath)}`));
  const stem = source.httpPath.replace(/\/+$/, "");
  let path = `${stem}/copy`;
  for (let n = 2; routes.has(`${source.httpMethod.toUpperCase()} ${pathTemplateKey(path)}`); n++) path = `${stem}/copy${n}`;
  const copy: ApiOperation = { ...op, name, httpPath: path, parameters: op.parameters.map((p) => ({ ...p })), responses: op.responses.map((r) => ({ ...r })), tags: [...op.tags] };
  delete copy.operationId;
  return copy;
}

/** `ids` with the element `id` moved one step up (-1) or down (+1); unchanged at the ends. */
export function moveId(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const out = [...ids];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

export interface TypeOptionGroups {
  primitives: readonly string[];
  entity: string;
  /** Other entities / data types, without the primitives and this entity. */
  others: string[];
}

/** The type picker's groups: primitives, this entity, then other entity / data-type names (deduplicated, sorted). */
export function typeOptionGroups(entityName: string, otherTypeNames: readonly string[]): TypeOptionGroups {
  const others = [...new Set(otherTypeNames.map((n) => n.trim()))]
    .filter((n) => n && n !== entityName && !isPrimitiveType(n))
    .sort((a, b) => a.localeCompare(b));
  return { primitives: PRIMITIVE_TYPES, entity: entityName, others };
}
