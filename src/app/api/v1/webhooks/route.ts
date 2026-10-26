/**
 * GET  /api/v1/webhooks — List all webhook endpoints (platform administrators only).
 * POST /api/v1/webhooks — Create a new webhook endpoint (platform administrators only).
 *
 * Endpoints belong to no tenant: they are a platform item, so the caller is a global administrator (a session) or the API key when its role
 * is ADMIN (`API_KEY_ROLE`). A list never carries an endpoint's signing secret; the answer of the creation shows it once.
 */

import { withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { readJsonBody } from "@/app/api/v1/request";
import { createEndpoint, getEndpoints } from "@/services/webhook.service";

export const GET = withApiAuth("platform.admin", async (_request, api) => {
  try {
    const result = await getEndpoints(api.ctx);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks error:", e);
    return apiServerError();
  }
});

export const POST = withApiAuth("platform.admin", async (request, api) => {
  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await createEndpoint(body.body as Parameters<typeof createEndpoint>[0], api.ctx);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data, "Webhook endpoint created", 201);
  } catch (e) {
    console.error("POST /api/v1/webhooks error:", e);
    return apiServerError();
  }
});
