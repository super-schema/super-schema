/**
 * POST /api/v1/schemas/:id/validate — Validate entity completeness.
 *
 * Runs the emission pipeline and returns per-target validation status.
 * Includes a `ci` field for CI/CD pipeline integration.
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import {
  apiSuccess,
  apiError,
  apiUnauthorized,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { getEntityById } from "@/services/entity.service";
import { prisma } from "@/lib/db";
import { emitFromData } from "@/lib/emission/emit-from-data";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Rate limit
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  // Authenticate
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated || !authResult.context) {
    return apiUnauthorized();
  }

  try {
    const { id } = await params;

    // Fetch entity
    const entityResult = await getEntityById(id, authResult.context);
    if (!entityResult.success) {
      return apiError(entityResult.error);
    }

    const entity = entityResult.data;

    // Load fields
    const fields = await prisma.field.findMany({
      where: { entityId: id },
      orderBy: { sortOrder: "asc" },
    });

    // Run emission pipeline (validation is part of emission)
    const emissionResult = emitFromData(
      entity as unknown as PrismaEntityInput,
      fields as unknown as PrismaFieldInput[]
    );

    // Format per-target validation results
    const targets = Object.values(emissionResult.targets).map((t) => ({
      target: t.name,
      status: t.validationStatus,
      errors: t.errors.map((e) => e.message),
      warnings: t.warnings.map((w) => w.message),
    }));

    const valid = emissionResult.success;
    const { totalTargets, validCount, warningCount, invalidCount } =
      emissionResult.summary;

    // CI-friendly summary
    const ciSummary = valid
      ? `All ${totalTargets} targets valid${warningCount > 0 ? ` (${warningCount} with warnings)` : ""}`
      : `${invalidCount} of ${totalTargets} targets invalid`;

    return apiSuccess({
      valid,
      entityId: id,
      entityName: entity.name,
      targets,
      summary: emissionResult.summary,
      ci: {
        pass: valid,
        summary: ciSummary,
      },
    });
  } catch (e) {
    console.error("POST /api/v1/schemas/:id/validate error:", e);
    return apiServerError();
  }
}
