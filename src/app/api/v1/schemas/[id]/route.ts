/**
 * GET /api/v1/schemas/:id — Get single entity with fields.
 *
 * Returns entity details including all fields and decorators.
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { getEntityById } from "@/services/entity.service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Authenticate
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const { id } = await params;
    const result = await getEntityById(id, authResult.context);

    if (!result.success) {
      return apiError(result.error);
    }

    return apiSuccess(result.data);
  } catch (e) {
    console.error("GET /api/v1/schemas/:id error:", e);
    return apiServerError();
  }
}
