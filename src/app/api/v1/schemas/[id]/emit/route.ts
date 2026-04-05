/**
 * POST /api/v1/schemas/:id/emit — Emit entity to all targets.
 *
 * Runs the emission pipeline (compile + emit to BigQuery, Avro, OpenAPI)
 * and returns per-target results.
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

    // Run emission pipeline
    const emissionResult = emitFromData(
      entity as unknown as PrismaEntityInput,
      fields as unknown as PrismaFieldInput[]
    );

    // Format per-target results
    const targets = Object.values(emissionResult.targets).map((t) => ({
      target: t.name,
      output: t.output,
      validationStatus: t.validationStatus,
      warnings: t.warnings.map((w) => w.message),
    }));

    return apiSuccess(
      {
        entityId: id,
        entityName: entity.name,
        version: entity.version,
        typespec: emissionResult.typespec,
        targets,
      },
      `Emitted to ${targets.length} targets — ${emissionResult.summary.validCount} valid, ${emissionResult.summary.warningCount} warnings, ${emissionResult.summary.invalidCount} invalid`
    );
  } catch (e) {
    console.error("POST /api/v1/schemas/:id/emit error:", e);
    return apiServerError();
  }
}
