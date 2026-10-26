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
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
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

    // Fetch entity with fields
    const entityResult = await getEntityById(id, api.ctx);
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
    // The root is an entity of the acting tenant that a role of the caller covers (`getEntityById` above), and the closure stays inside that tenant. Every
    // entity the root references (transitively) must be covered by a role of the caller too, or the run is refused before anything is built from it: 403
    // REFERENCE_NOT_READABLE, a message that names nothing of the other entity (KD-045).
    const run = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft", entityReader(api.principal.assignments));
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
}, { before: (request) => checkRateLimit(request) });

