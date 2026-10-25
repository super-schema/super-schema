/**
 * GET /api/v1/webhooks/:id/deliveries — List delivery history for a webhook endpoint (Admin only).
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import { getDeliveries } from "@/services/webhook.service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("webhook", id);
    const result = await getDeliveries(id, authResult.context);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks/:id/deliveries error:", e);
    return apiServerError();
  }
}
