/**
 * POST /api/v1/schemas/:id/emit — Emit entity to every enabled schema target.
 *
 * Runs the emission pipeline and returns per-target results. Every target is
 * now `runtime: "typespec-cli"` (real TypeSpec packages) as of 2026-10-12 —
 * the native registry `emitFromData()` used to loop is permanently empty, so
 * this route no longer calls it for per-target output.
 *
 * The closure targets (JSON Schema, OpenAPI 3, Protobuf, Avro, Java POJO) emit the entity together with everything it references,
 * one file per entity, from the entity's current saved state (draft mode: `resolution.preview` is then true). A target result is
 * `{ target, output, files?, validationStatus, warnings }`: `files` (path, content, target, entityId) is the structured form of
 * `output`, which is their bundled `===== path =====` string; the DB targets emit one string and have no `files`. `data.files` is
 * every file of the run in one list, each tagged by its target. A bare-name reference that matches several entities is not guessed:
 * the whole request fails with 422 `AMBIGUOUS_REFERENCE` and `error.details` = `{ field, name, candidates, entityId, fieldId }`.
 */

import { authenticateRequest } from "@/app/api/v1/middleware";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
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
    if (!isUsableId(id)) return unusableIdNotFound("entity", id);

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

    const prismaEntity = entity as unknown as PrismaEntityInput & { tenantId: string };
    const prismaFields = fields as unknown as PrismaFieldInput[];

    const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    // The closure stays inside the entity's own tenant; this route (unlike the entity page) does not scope the root to a session tenant.
    const run = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft");
    if (run.refusal) return apiError(run.refusal);
    const results = run.results.map(({ target, result }) => ({
      target: target.key,
      output: result.output,
      ...(result.files ? { files: result.files } : {}),
      validationStatus: result.validationStatus,
      warnings: result.warnings,
    }));

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
        files: run.results.flatMap(({ result }) => result.files ?? []),
        ...(run.resolution ? { resolution: run.resolution } : {}),
      },
      `Emitted to ${results.length} targets — ${validCount} valid, ${warningCount} warnings, ${invalidCount} invalid`
    );
  } catch (e) {
    console.error("POST /api/v1/schemas/:id/emit error:", e);
    return apiServerError();
  }
}

