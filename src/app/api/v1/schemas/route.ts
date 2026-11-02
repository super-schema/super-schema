/**
 * GET /api/v1/schemas — List the entities the caller may read, with basic metadata.
 *
 * Query params: domain, status, search
 * Returns: { success, data, summary }
 *
 * Only the entities of the tenant the caller acts in (a session's active tenant, the API key's tenant) that one of the caller's roles covers
 * (`entity.read`): the service restricts the query to them (a tenant-wide role lists them all, a domain- or product-scoped role only its own).
 */

import { withApiAuth } from "@/lib/access/api";
import { apiSuccess, apiError, apiServerError } from "@/app/api/v1/error-handler";
import { getEntities } from "@/services/entity.service";
import { optionalParam, queryProblem } from "@/app/api/v1/request";
import { EntityFiltersSchema } from "@/types/schemas/entity.schema";

export const GET = withApiAuth("entity.read", async (request, api) => {
  try {
    const url = new URL(request.url);
    const bad = queryProblem(url);
    if (bad) return bad;
    // A status that is none of the four is the caller's mistake (400), not a query for the database to refuse (500).
    const parsed = EntityFiltersSchema.safeParse({
      domainId: optionalParam(url, "domain"),
      status: optionalParam(url, "status"),
      search: optionalParam(url, "search"),
    });
    if (!parsed.success) {
      return apiError({
        code: "VALIDATION_ERROR",
        message: parsed.error.issues[0].message,
        suggestedFix: parsed.error.issues[0].path[0] === "status" ? "status is one of DRAFT, ACTIVE, DEPRECATED, RETIRED." : "Remove the NUL byte (%00) from the filter.",
      });
    }

    const result = await getEntities(parsed.data, api.ctx);

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
}, { rateLimit: true });
