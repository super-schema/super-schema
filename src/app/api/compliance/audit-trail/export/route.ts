import { NextResponse } from "next/server";
import { COMPLIANCE_ERRORS, withApiAuth } from "@/lib/access/api";
import { exportAuditTrail } from "@/services/compliance.service";
import { MAX_EXPORT_ROWS } from "@/types/schemas/compliance";
import { AuditExportBodySchema, readBody, statusOf } from "../../_body";

/**
 * The Audit Trail's export: every entry of the filters (not the page on the screen), up to `MAX_EXPORT_ROWS`. `truncated` says the export was cut
 * short; `total` is how many matched. Decided exactly as the list is (`compliance.audit`: the tenant as a whole).
 */
export const POST = withApiAuth(
  "compliance.audit",
  async (req, api) => {
    const body = await readBody(req, AuditExportBodySchema);
    if (!body.ok) return body.response;
    const result = await exportAuditTrail(body.data.filters ?? {}, api.ctx);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
    }
    return NextResponse.json({ success: true, data: { ...result.data, limit: MAX_EXPORT_ROWS } });
  },
  { respond: COMPLIANCE_ERRORS, allowApiKey: false }
);
