/**
 * POST /api/v1/schemas/:id/validate — Validate entity completeness.
 *
 * Runs the emission pipeline across every enabled schema target and returns
 * per-target validation status. Includes a `ci` field for CI/CD pipeline
 * integration. Every target is `runtime: "typespec-cli"` as of 2026-10-12 —
 * see the emit route's doc comment for why this no longer calls `emitFromData`.
 *
 * The closure targets are validated by emitting the entity together with everything it references (see the emit route): a target
 * result is `{ target, status, errors, warnings, files? }` and `data.resolution` says which version of each entity was used. An
 * ambiguous bare-name reference fails the request with 422 `AMBIGUOUS_REFERENCE` (structured, with the candidates).
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
import { emitTargetsForEntity } from "@/lib/emission/emission.service";
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

    const prismaEntity = entity as unknown as PrismaEntityInput & { tenantId: string };
    const prismaFields = fields as unknown as PrismaFieldInput[];

    // Run emission pipeline (validation is part of emission)
    const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    const run = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft");
    if (run.refusal) return apiError(run.refusal);
    const results = run.results.map(({ target, result }) => ({
      target: target.key,
      status: result.validationStatus,
      errors: result.errors.map((e) => e.message),
      warnings: result.warnings,
      ...(result.files ? { files: result.files } : {}),
    }));

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
      ...(run.resolution ? { resolution: run.resolution } : {}),
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

