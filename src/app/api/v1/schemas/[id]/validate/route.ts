/**
 * POST /api/v1/schemas/:id/validate — Validate entity completeness.
 *
 * Runs the emission pipeline across every enabled schema target and returns
 * per-target validation status. Includes a `ci` field for CI/CD pipeline
 * integration. Every target is `runtime: "typespec-cli"` as of 2026-10-12 —
 * see the emit route's doc comment for why this no longer calls `emitFromData`.
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
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
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

    const prismaEntity = entity as unknown as PrismaEntityInput;
    const prismaFields = fields as unknown as PrismaFieldInput[];

    // Run emission pipeline (validation is part of emission)
    const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    const results = await Promise.all(
      enabledTargets.map(async (target) => {
        const result = await emitOfficialTypeSpecTargetFromData(prismaEntity, prismaFields, target.key);
        return {
          target: target.key,
          status: result.validationStatus,
          errors: result.errors.map((e) => e.message),
          warnings: result.warnings,
        };
      })
    );

    const totalTargets = results.length;
    const validCount = results.filter((r) => r.status === "VALID").length;
    const invalidCount = results.filter((r) => r.status === "INVALID").length;
    const warningCount = totalTargets - validCount - invalidCount;
    const valid = invalidCount === 0;

    // CI-friendly summary
    const ciSummary = valid
      ? `All ${totalTargets} targets valid${warningCount > 0 ? ` (${warningCount} with warnings)` : ""}`
      : `${invalidCount} of ${totalTargets} targets invalid`;

    return apiSuccess({
      valid,
      entityId: id,
      entityName: entity.name,
      targets: results,
      summary: { totalTargets, validCount, warningCount, invalidCount },
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

