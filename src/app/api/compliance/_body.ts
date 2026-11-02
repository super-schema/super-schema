import { NextResponse } from "next/server";
import { z } from "zod";
import type { ServiceError } from "@/types/result";
import {
  AuditPaginationSchema,
  AuditTrailFilterSchema,
  ComplianceFilterSchema,
  GapFilterSchema,
  PaginationSchema,
} from "@/types/schemas/compliance";

/**
 * The request bodies of the compliance routes. A body that is empty or not JSON is the default query (what the routes always did); a body
 * that IS JSON must have the shape and the bounds of these schemas, or the answer is a 400 in fixed words (the paths and rules of the schema,
 * never the value that broke them, never driver text): `pageSize: 1e9` used to dump the table, `page: -1` threw, and a NUL in a text filter came
 * back as Prisma / Postgres error text.
 */
export const QueryBodySchema = z.object({ filters: ComplianceFilterSchema.optional(), pagination: PaginationSchema.optional() });
export const GapsBodySchema = z.object({ filters: GapFilterSchema.optional() });
export const AuditTrailBodySchema = z.object({ filters: AuditTrailFilterSchema.optional(), pagination: AuditPaginationSchema.optional() });
/** The Query export: the same filters, and the sort the list is in (no page: an export is every match, up to the cap). */
export const FieldExportBodySchema = z.object({ filters: ComplianceFilterSchema.optional(), sort: PaginationSchema.pick({ sortBy: true, sortOrder: true }).optional() });
/** The Audit Trail export: the same filters as the list (no page). */
export const AuditExportBodySchema = z.object({ filters: AuditTrailFilterSchema.optional() });

export async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const raw: unknown = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const details = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  return { ok: false, response: NextResponse.json({ success: false, error: "Invalid request", details }, { status: 400 }) };
}

/** The HTTP status of a failed service result: FORBIDDEN is 403, an unexpected failure is 500 (its text is already fixed words), the rest 400. */
export function statusOf(error: ServiceError): number {
  return error.code === "FORBIDDEN" ? 403 : error.code === "INTERNAL_ERROR" ? 500 : 400;
}
