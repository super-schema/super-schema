/**
 * GET  /api/v1/webhooks — List all webhook endpoints (Admin only).
 * POST /api/v1/webhooks — Create a new webhook endpoint (Admin only).
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { readJsonBody } from "@/app/api/v1/request";
import { createEndpoint, getEndpoints } from "@/services/webhook.service";

export async function GET(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const result = await getEndpoints(authResult.context);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/webhooks error:", e);
    return apiServerError();
  }
}

export async function POST(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const result = await createEndpoint(body.body as Parameters<typeof createEndpoint>[0], authResult.context);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data, "Webhook endpoint created", 201);
  } catch (e) {
    console.error("POST /api/v1/webhooks error:", e);
    return apiServerError();
  }
}
