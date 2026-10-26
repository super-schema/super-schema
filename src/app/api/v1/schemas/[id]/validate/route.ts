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

import { withApiAuth } from "@/lib/access/api";
import { entityReader } from "@/lib/access/entity-reader";
import { checkRateLimit } from "@/app/api/v1/rate-limit";
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import {
  apiSuccess,
  apiError,
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

// The rate limit comes first, before the credential is looked at (a request without one counts too); then who, which tenant and whether any role
// reaches `entity.read`; `getEntityById` then answers one NOT_FOUND for an entity that is missing, of another tenant or that no role covers.
export const POST = withApiAuth<{ id: string }>("entity.read", async (_request, api, { params }) => {
  try {
    const { id } = await params;
    if (!isUsableId(id)) return unusableIdNotFound("entity", id);

    // Fetch entity
    const entityResult = await getEntityById(id, api.ctx);
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

    // Run emission pipeline (validation is part of emission). The closure only holds what the caller's roles cover: an entity the schema refers to that
    // they may not read refuses the whole request (403 REFERENCE_NOT_READABLE) before anything is built from it (KD-045).
    const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
    const run = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft", entityReader(api.principal.assignments));
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
}, { before: (request) => checkRateLimit(request) });

