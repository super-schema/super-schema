import { NextResponse } from "next/server";
import { COMPLIANCE_ERRORS, withApiAuth } from "@/lib/access/api";
import { detectGaps } from "@/services/compliance.service";
import { GapsBodySchema, readBody, statusOf } from "../_body";

/** The Gaps tab: the gaps of the tenant in view's entities that the caller's compliance role reaches (`compliance.gaps`, judged per entity by the service). */
export const POST = withApiAuth(
  "compliance.gaps",
  async (req, api) => {
    const body = await readBody(req, GapsBodySchema);
    if (!body.ok) return body.response;
    const result = await detectGaps(body.data.filters ?? {}, api.ctx);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
    }
    return NextResponse.json({ success: true, data: result.data });
  },
  { respond: COMPLIANCE_ERRORS, allowApiKey: false }
);
