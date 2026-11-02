import { NextResponse } from "next/server";
import { COMPLIANCE_ERRORS, withApiAuth } from "@/lib/access/api";
import { exportFields } from "@/services/compliance.service";
import { MAX_EXPORT_ROWS, PaginationSchema } from "@/types/schemas/compliance";
import { FieldExportBodySchema, readBody, statusOf } from "../../_body";

/**
 * The Query tab's export: every field the filters select (not the page on the screen), in the sort the list is in, up to `MAX_EXPORT_ROWS`.
 * `truncated` says the export was cut short; `total` is how many matched. Decided exactly as the list is (`compliance.query`, per entity).
 */
export const POST = withApiAuth(
  "compliance.query",
  async (req, api) => {
    const body = await readBody(req, FieldExportBodySchema);
    if (!body.ok) return body.response;
    const sort = body.data.sort ?? PaginationSchema.pick({ sortBy: true, sortOrder: true }).parse({});
    const result = await exportFields(body.data.filters ?? {}, sort, api.ctx);
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error.message }, { status: statusOf(result.error) });
    }
    return NextResponse.json({ success: true, data: { ...result.data, limit: MAX_EXPORT_ROWS } });
  },
  { respond: COMPLIANCE_ERRORS, allowApiKey: false }
);
