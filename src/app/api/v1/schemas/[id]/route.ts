/**
 * GET /api/v1/schemas/:id — Get single entity with fields.
 *
 * Returns entity details including all fields and decorators. An entity of another tenant, one no role of the caller covers and one that
 * does not exist are the same 404.
 */

import { withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import { getEntityById } from "@/services/entity.service";

export const GET = withApiAuth<{ id: string }>("entity.read", async (_request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("entity", id);
    const result = await getEntityById(id, api.ctx);

    if (!result.success) {
      return apiError(result.error);
    }

    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/schemas/:id error:", e);
    return apiServerError();
  }
});
