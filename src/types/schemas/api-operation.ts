import { z } from "zod";

import { MetadataAttributeKeySchema } from "@/types/schemas/metadata-attribute";

/**
 * Shared contract for API operations (OpenAPI 3.1 Operation Object subset). The DB rows, server actions, TypeSpec
 * emission, OpenAPI import and the API tab editor all speak this shape. Do not fork it; extend it here.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export const PARAM_LOCATIONS = ["path", "query", "header", "cookie"] as const;
/** Pre-contract editor location for a body "parameter". Read and accepted as `requestBody`; never stored. */
export const LEGACY_BODY_LOCATION = "body";
/** Primitive type names (OpenAPI type+format collapsed). Anything else is an entity/data-type name. */
export const PRIMITIVE_TYPES = [
  "string", "int32", "int64", "float", "double", "boolean", "date", "date-time", "uuid", "bytes",
] as const;

export const apiTypeRefSchema = z.object({
  /** primitive name from PRIMITIVE_TYPES, or the name of an entity / data type. */
  type: z.string().min(1),
  /** true = array of `type`. */
  isArray: z.boolean().default(false),
});

export const apiParameterSchema = apiTypeRefSchema.extend({
  name: z.string().min(1),
  location: z.enum(PARAM_LOCATIONS),
  required: z.boolean().default(false),
  description: z.string().default(""),
});

export const apiRequestBodySchema = apiTypeRefSchema.extend({
  contentType: z.string().default("application/json"),
  required: z.boolean().default(true),
  description: z.string().default(""),
});

export const apiResponseSchema = z.object({
  statusCode: z.number().int().min(100).max(599),
  /** null/undefined = no body. */
  type: z.string().nullable().optional(),
  isArray: z.boolean().default(false),
  contentType: z.string().default("application/json"),
  description: z.string().default(""),
});

export const apiOperationSchema = z.object({
  name: z.string().min(1),
  /** OpenAPI operationId; defaults to name. */
  operationId: z.string().optional(),
  summary: z.string().default(""),
  description: z.string().default(""),
  httpMethod: z.enum(HTTP_METHODS),
  httpPath: z.string().startsWith("/"),
  tags: z.array(z.string()).default([]),
  deprecated: z.boolean().default(false),
  parameters: z.array(apiParameterSchema).default([]),
  requestBody: apiRequestBodySchema.nullable().default(null),
  responses: z.array(apiResponseSchema).default([]),
  /** Metadata attributes (`x-*` key -> JSON value); stored at `Operation.decorators.extensions`. Absent = none. */
  extensions: z.record(MetadataAttributeKeySchema, z.json()).optional(),
});

export type ApiTypeRef = z.infer<typeof apiTypeRefSchema>;
export type ApiParameter = z.infer<typeof apiParameterSchema>;
export type ApiRequestBody = z.infer<typeof apiRequestBodySchema>;
export type ApiResponse = z.infer<typeof apiResponseSchema>;
export type ApiOperation = z.infer<typeof apiOperationSchema>;

/** What a caller may send (defaults not yet applied). */
export type ApiOperationInput = z.input<typeof apiOperationSchema>;

/**
 * A stored operation as the loaders hand it to the editor: the contract plus its row ids. A response's `type` is always
 * present here (null = no body).
 */
export type ApiOperationRecord = Omit<ApiOperation, "responses"> & {
  id: string;
  serviceId: string;
  responses: (Omit<ApiResponse, "type"> & { type: string | null })[];
};
