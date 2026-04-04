/**
 * GET /api/v1/schemas — List all entities with basic metadata.
 *
 * Query params: domain, status, search
 * Returns: { success, data, summary }
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { getEntities } from "@/services/entity.service";

export async function GET(request: Request) {
  // Authenticate
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const url = new URL(request.url);
    const filters: import("@/types/schemas/entity.schema").EntityFilters = {
      domainId: url.searchParams.get("domain") ?? undefined,
      status: (url.searchParams.get("status") ?? undefined) as "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED" | undefined,
      search: url.searchParams.get("search") ?? undefined,
    };

    const result = await getEntities(filters, authResult.context);

    if (!result.success) {
      return apiError(result.error);
    }

    const entities = result.data.map((entity) => ({
      id: entity.id,
      name: entity.name,
      description: entity.description,
      status: entity.status,
      version: entity.version,
      domainId: entity.domainId,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    }));

    return apiSuccess(entities, `Found ${entities.length} entities`);
  } catch (e) {
    console.error("GET /api/v1/schemas error:", e);
    return apiServerError();
  }
}
