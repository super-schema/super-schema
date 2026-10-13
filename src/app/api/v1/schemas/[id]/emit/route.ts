/**
 * POST /api/v1/schemas/:id/emit — Emit entity to every enabled schema target.
 *
 * Runs the emission pipeline and returns per-target results. Every target is
 * now `runtime: "typespec-cli"` (real TypeSpec packages) as of 2026-10-12 —
 * the native registry `emitFromData()` used to loop is permanently empty, so
 * this route no longer calls it for per-target output.
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
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
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

    // Fetch entity with fields
    const entityResult = await getEntityById(id, authResult.context);
    if (!entityResult.success) {
      return apiError(entityResult.error);
    }

    const entity = entityResult.data;

    // Load fields for emission
    const fields = await prisma.field.findMany({
      where: { entityId: id },
      orderBy: { sortOrder: "asc" },
    });

    const prismaEntity = entity as unknown as PrismaEntityInput;
    const prismaFields = fields as unknown as PrismaFieldInput[];

    const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    const results = await Promise.all(
      enabledTargets.map(async (target) => {
        const result = await emitOfficialTypeSpecTargetFromData(prismaEntity, prismaFields, target.key);
        return {
          target: target.key,
          output: result.output,
          validationStatus: result.validationStatus,
          warnings: result.warnings,
        };
      })
    );

    const validCount = results.filter((r) => r.validationStatus === "VALID").length;
    const invalidCount = results.filter((r) => r.validationStatus === "INVALID").length;
    const warningCount = results.length - validCount - invalidCount;

    return apiSuccess(
      {
        entityId: id,
        entityName: entity.name,
        version: entity.version,
        typespec: generateTypeSpec(compileEntity(prismaEntity, prismaFields)),
        targets: results,
      },
      `Emitted to ${results.length} targets — ${validCount} valid, ${warningCount} warnings, ${invalidCount} invalid`
    );
  } catch (e) {
    console.error("POST /api/v1/schemas/:id/emit error:", e);
    return apiServerError();
  }
}

