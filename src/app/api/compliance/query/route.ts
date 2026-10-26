import { NextResponse } from "next/server";
import { COMPLIANCE_ERRORS, withApiAuth } from "@/lib/access/api";
import { queryFields } from "@/services/compliance.service";
import { PaginationSchema } from "@/types/schemas/compliance";
import { QueryBodySchema, readBody, statusOf } from "../_body";

/**
 * The Query tab: the fields of the tenant in view that the caller's compliance role reaches (`compliance.query`, judged per entity by the service).
 * `withApiAuth` answers 401 (no session), 404 (no role in the tenant) and 403 (no role that reaches the action) before the body is read.
 */
export const POST = withApiAuth(
  "compliance.query",
  async (req, api) => {
    const body = await readBody(req, QueryBodySchema);
    if (!body.ok) return body.response;
    const result = await queryFields(body.data.filters ?? {}, body.data.pagination ?? PaginationSchema.parse({}), api.ctx);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
    }
    return NextResponse.json({ success: true, data: result.data });
  },
  { respond: COMPLIANCE_ERRORS, allowApiKey: false }
);
