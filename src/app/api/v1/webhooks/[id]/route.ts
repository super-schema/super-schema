/**
 * PUT    /api/v1/webhooks/:id — Update a webhook endpoint of the acting tenant (platform administrators only).
 * DELETE /api/v1/webhooks/:id — Delete a webhook endpoint of the acting tenant (platform administrators only).
 *
 * See ./route.ts: an endpoint belongs to one tenant, and another tenant's endpoint is answered as a missing one. The answer of an update carries no
 * signing secret.
 */

import { platformActingTenant, withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { isUsableId, readJsonBody, unusableIdNotFound } from "@/app/api/v1/request";
import { updateEndpoint, deleteEndpoint } from "@/services/webhook.service";

export const PUT = withApiAuth<{ id: string }>("platform.admin", async (request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("webhook", id);
    const tenantId = await platformActingTenant(api);
    if (tenantId === null) return apiError({ code: "NOT_FOUND", message: "Not found" });
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await updateEndpoint(id, body.body as Parameters<typeof updateEndpoint>[1], { ...api.ctx, tenantId });
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("PUT /api/v1/webhooks/:id error:", e);
    return apiServerError();
  }
});

export const DELETE = withApiAuth<{ id: string }>("platform.admin", async (_request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("webhook", id);
    const tenantId = await platformActingTenant(api);
    if (tenantId === null) return apiError({ code: "NOT_FOUND", message: "Not found" });
    const result = await deleteEndpoint(id, { ...api.ctx, tenantId });
    if (!result.success) return apiError(result.error);
    return apiSuccess({ deleted: true });
  } catch (e) {
    console.error("DELETE /api/v1/webhooks/:id error:", e);
    return apiServerError();
  }
});
