/**
 * GET /api/v1/webhooks/:id/deliveries — List the delivery history of a webhook endpoint of the acting tenant (platform administrators only).
 * Another tenant's endpoint is answered as a missing one.
 */

import { platformActingTenant, withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import { getDeliveries } from "@/services/webhook.service";

export const GET = withApiAuth<{ id: string }>("platform.admin", async (_request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("webhook", id);
    const tenantId = await platformActingTenant(api);
    if (tenantId === null) return apiError({ code: "NOT_FOUND", message: "Not found" });
    const result = await getDeliveries(id, { ...api.ctx, tenantId });
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks/:id/deliveries error:", e);
    return apiServerError();
  }
}, { rateLimit: true });
