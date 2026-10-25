import { NextResponse } from "next/server";
import { queryAuditTrail } from "@/services/compliance.service";
import { AuditPaginationSchema } from "@/types/schemas/compliance";
import { resolveContext } from "../_context";
import { AuditTrailBodySchema, readBody, statusOf } from "../_body";

export async function POST(req: Request) {
  const auth = await resolveContext();
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.message }, { status: auth.status });
  }
  const body = await readBody(req, AuditTrailBodySchema);
  if (!body.ok) return body.response;
  const result = await queryAuditTrail(body.data.filters ?? {}, body.data.pagination ?? AuditPaginationSchema.parse({}), auth.ctx);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
  }
  return NextResponse.json({ success: true, data: result.data });
}
