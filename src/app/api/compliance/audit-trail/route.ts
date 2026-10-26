import { NextResponse } from "next/server";
import { COMPLIANCE_ERRORS, withApiAuth } from "@/lib/access/api";
import { queryAuditTrail } from "@/services/compliance.service";
import { AuditPaginationSchema } from "@/types/schemas/compliance";
import { AuditTrailBodySchema, readBody, statusOf } from "../_body";

/**
 * The Audit Trail tab: the audit rows of the tenant in view (`audit_log.tenantId`), for a compliance officer or administrator of the whole tenant
 * (`compliance.audit` is held over the tenant, not a domain). Rows no tenant owns are shown to platform administrators only (KD-016).
 */
export const POST = withApiAuth(
  "compliance.audit",
  async (req, api) => {
    const body = await readBody(req, AuditTrailBodySchema);
    if (!body.ok) return body.response;
    const result = await queryAuditTrail(body.data.filters ?? {}, body.data.pagination ?? AuditPaginationSchema.parse({}), api.ctx);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
    }
    return NextResponse.json({ success: true, data: result.data });
  },
  { respond: COMPLIANCE_ERRORS, allowApiKey: false }
);
