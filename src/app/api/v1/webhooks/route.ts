/**
 * GET  /api/v1/webhooks — List the webhook endpoints of the tenant the request acts in (platform administrators only).
 * POST /api/v1/webhooks — Create a webhook endpoint in that tenant (platform administrators only).
 *
 * An endpoint belongs to one tenant, and it is sent that tenant's events only. The tenant is the API key's own (API_KEY_TENANT_ID) or the
 * session's active tenant; the input cannot name another one. A list never carries an endpoint's signing secret; the answer of the creation shows
 * it once.
 */

import { platformActingTenant, withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { readJsonBody } from "@/app/api/v1/request";
import { createEndpoint, getEndpoints } from "@/services/webhook.service";

export const GET = withApiAuth("platform.admin", async (_request, api) => {
  try {
    const tenantId = await platformActingTenant(api);
    if (tenantId === null) return apiError({ code: "NOT_FOUND", message: "Not found" });
    const result = await getEndpoints({ ...api.ctx, tenantId });
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks error:", e);
    return apiServerError();
  }
});

export const POST = withApiAuth("platform.admin", async (request, api) => {
  try {
    const tenantId = await platformActingTenant(api);
    if (tenantId === null) return apiError({ code: "NOT_FOUND", message: "Not found" });
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await createEndpoint(body.body as Parameters<typeof createEndpoint>[0], { ...api.ctx, tenantId });
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data, "Webhook endpoint created", 201);
  } catch (e) {
    console.error("POST /api/v1/webhooks error:", e);
    return apiServerError();
  }
});
