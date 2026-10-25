import { NextResponse } from "next/server";
import { queryFields } from "@/services/compliance.service";
import { PaginationSchema } from "@/types/schemas/compliance";
import { resolveContext } from "../_context";
import { QueryBodySchema, readBody, statusOf } from "../_body";

export async function POST(req: Request) {
  const auth = await resolveContext();
  if (!auth.ok) {
    return NextResponse.json({ success: false, error: auth.message }, { status: auth.status });
  }
  const body = await readBody(req, QueryBodySchema);
  if (!body.ok) return body.response;
  const result = await queryFields(body.data.filters ?? {}, body.data.pagination ?? PaginationSchema.parse({}), auth.ctx);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
  }
  return NextResponse.json({ success: true, data: result.data });
}
