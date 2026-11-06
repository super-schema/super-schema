import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import {
  apiRequestBodySchema,
  HTTP_METHODS,
  LEGACY_BODY_LOCATION,
  PARAM_LOCATIONS,
  type ApiOperation,
  type ApiOperationRecord,
  type ApiParameter,
  type ApiRequestBody,
} from "@/types/schemas/api-operation";

/**
 * Operation rows <-> the `api-operation.ts` contract. Reading is lenient (rows written before the contract, or by the bulk
 * import, may carry a lower-case method, a legacy "body" parameter, malformed JSON columns); writing takes a contract
 * operation that already passed `validateApiOperation`.
 */

export interface OperationRow {
  id: string;
  serviceId: string;
  name: string;
  operationId?: string | null;
  summary?: string | null;
  description: string;
  httpMethod: string;
  httpPath: string;
  tags?: unknown;
  deprecated?: boolean | null;
  requestBody?: unknown;
  parameters: {
    name: string;
    type: string;
    isArray?: boolean | null;
    location: string;
    required: boolean;
    description: string;
    sortOrder?: number | null;
  }[];
  responses: {
    statusCode: number;
    type: string | null;
    isArray?: boolean | null;
    contentType?: string | null;
    description: string;
    sortOrder?: number | null;
  }[];
}

/** Include for loaders: parameters and responses in editor order. */
export const OPERATION_DETAILS_INCLUDE = {
  parameters: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
  responses: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
} satisfies Prisma.OperationInclude;

const tagsSchema = z.array(z.string());
const isLocation = (v: string): v is ApiParameter["location"] => (PARAM_LOCATIONS as readonly string[]).includes(v);
const isMethod = (v: string): v is ApiOperation["httpMethod"] => (HTTP_METHODS as readonly string[]).includes(v);
const bySortOrder = <T extends { sortOrder?: number | null }>(rows: T[]) =>
  rows.map((row, i) => ({ row, i })).sort((a, b) => (a.row.sortOrder ?? 0) - (b.row.sortOrder ?? 0) || a.i - b.i).map((x) => x.row);

/** A stored operation in the contract shape (plus its ids). A legacy "body" parameter reads as the request body. */
export function operationRecordFromRow(row: OperationRow): ApiOperationRecord {
  const params = bySortOrder(row.parameters);
  const legacyBody = params.find((p) => p.location === LEGACY_BODY_LOCATION);
  const stored = row.requestBody == null ? null : apiRequestBodySchema.safeParse(row.requestBody);
  let requestBody: ApiRequestBody | null = stored?.success ? stored.data : null;
  if (!requestBody && legacyBody) {
    requestBody = {
      type: legacyBody.type,
      isArray: legacyBody.isArray ?? false,
      contentType: "application/json",
      required: legacyBody.required,
      description: legacyBody.description,
    };
  }
  const tags = tagsSchema.safeParse(row.tags);
  const method = row.httpMethod.trim().toUpperCase();
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    ...(row.operationId ? { operationId: row.operationId } : {}),
    summary: row.summary ?? "",
    description: row.description,
    httpMethod: isMethod(method) ? method : "GET",
    httpPath: row.httpPath.startsWith("/") ? row.httpPath : `/${row.httpPath}`,
    tags: tags.success ? tags.data : [],
    deprecated: row.deprecated ?? false,
    parameters: params
      .filter((p) => p.location !== LEGACY_BODY_LOCATION)
      .map((p) => ({
        name: p.name,
        type: p.type,
        isArray: p.isArray ?? false,
        location: isLocation(p.location) ? p.location : "query",
        required: p.required,
        description: p.description,
      })),
    requestBody,
    responses: bySortOrder(row.responses).map((r) => ({
      statusCode: r.statusCode,
      type: r.type,
      isArray: r.isArray ?? false,
      contentType: r.contentType ?? "application/json",
      description: r.description,
    })),
  };
}

/** The contract part of a record (drops the ids), for sibling checks. */
export function operationFromRecord(record: ApiOperationRecord): ApiOperation {
  const op: Partial<ApiOperationRecord> = { ...record };
  delete op.id;
  delete op.serviceId;
  return op as ApiOperation;
}

/** The scalar columns of an operation. */
export function operationColumns(op: ApiOperation) {
  return {
    name: op.name,
    operationId: op.operationId ?? null,
    summary: op.summary,
    description: op.description,
    httpMethod: op.httpMethod,
    httpPath: op.httpPath,
    tags: op.tags,
    deprecated: op.deprecated,
    requestBody: op.requestBody ? (op.requestBody as Prisma.InputJsonObject) : Prisma.DbNull,
  };
}

/** Parameter / response rows to create, in list order. */
export function operationChildRows(op: ApiOperation) {
  return {
    parameters: op.parameters.map((p, sortOrder) => ({
      name: p.name,
      type: p.type,
      isArray: p.isArray,
      location: p.location,
      required: p.required,
      description: p.description,
      sortOrder,
    })),
    responses: op.responses.map((r, sortOrder) => ({
      statusCode: r.statusCode,
      type: r.type ?? null,
      isArray: r.isArray,
      contentType: r.contentType,
      description: r.description,
      sortOrder,
    })),
  };
}
