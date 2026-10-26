/**
 * GET /api/v1/webhooks/:id/deliveries — List delivery history for a webhook endpoint (platform administrators only).
 */

import { withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import { getDeliveries } from "@/services/webhook.service";

export const GET = withApiAuth<{ id: string }>("platform.admin", async (_request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("webhook", id);
    const result = await getDeliveries(id, api.ctx);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks/:id/deliveries error:", e);
    return apiServerError();
  }
});
