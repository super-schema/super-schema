import { NextResponse } from "next/server";
import { queryAuditTrail } from "@/services/compliance.service";
import { resolveContext } from "../_context";

export async function POST(req: Request) {
  const auth = await resolveContext();
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.message }, { status: auth.status });
  }
  const body = await req.json().catch(() => ({}));
  const result = await queryAuditTrail(body.filters ?? {}, body.pagination, auth.ctx);
  if (!result.success) {
    const status = result.error.code === "FORBIDDEN" ? 403 : 400;
    return NextResponse.json({ success: false, error: result.error.message }, { status });
  }
  return NextResponse.json({ success: true, data: result.data });
}
