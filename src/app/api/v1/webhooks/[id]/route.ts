/**
 * PUT    /api/v1/webhooks/:id — Update a webhook endpoint (Admin only).
 * DELETE /api/v1/webhooks/:id — Delete a webhook endpoint (Admin only).
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { updateEndpoint, deleteEndpoint } from "@/services/webhook.service";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const { id } = await params;
    const body = await request.json();
    const result = await updateEndpoint(id, body, authResult.context);
    if (!result.success) return apiError(result.error);
    return apiSuccess(result.data);
  } catch (e) {
    console.error("PUT /api/v1/webhooks/:id error:", e);
    return apiServerError();
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const { id } = await params;
    const result = await deleteEndpoint(id, authResult.context);
    if (!result.success) return apiError(result.error);
    return apiSuccess({ deleted: true });
  } catch (e) {
    console.error("DELETE /api/v1/webhooks/:id error:", e);
    return apiServerError();
  }
}
