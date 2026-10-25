import { NextResponse } from "next/server";
import { detectGaps } from "@/services/compliance.service";
import { resolveContext } from "../_context";
import { GapsBodySchema, readBody, statusOf } from "../_body";

export async function POST(req: Request) {
  const auth = await resolveContext();
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.message }, { status: auth.status });
  }
  const body = await readBody(req, GapsBodySchema);
  if (!body.ok) return body.response;
  const result = await detectGaps(body.data.filters ?? {}, auth.ctx);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
  }
  return NextResponse.json({ success: true, data: result.data });
}
