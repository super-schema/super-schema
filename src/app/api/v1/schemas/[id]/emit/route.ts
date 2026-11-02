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
import { isUsableId, unusableIdNotFound } from "@/app/api/v1/request";
import {
  apiSuccess,
  apiError,
  apiBusy,
  apiCompilerSharesInUse,
  apiServerError,
} from "@/app/api/v1/error-handler";
import { getEntityById } from "@/services/entity.service";
import { prisma } from "@/lib/db";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitTargetsForEntity } from "@/lib/emission/emission.service";
import { admitCompilerRuns } from "@/lib/emission/emission-admission";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { runAfterResponse } from "@/lib/after-response";
import { notifyEntityEmitted } from "@/services/notification.triggers";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";

// The credential is checked first (who, which tenant, whether any role reaches `entity.read`), then the rate limit (`rateLimit`: a request that does not
// authenticate counts against its address, an authenticated one against its principal). `getEntityById` then answers one NOT_FOUND for an entity that
// is missing, of another tenant or that no role covers.
export const POST = withApiAuth<{ id: string }>("entity.read", async (request, api, { params }) => {
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
    // The caller's share of the compiler: one run per target, refused at once (429) when it is used up (src/lib/emission/emission-admission.ts).
    const share = admitCompilerRuns(api.principal.userId, enabledTargets.length);
    if (!share) return apiCompilerSharesInUse();
    // The root is an entity of the acting tenant that a role of the caller covers (`getEntityById` above), and the closure stays inside that tenant. Every
    // entity the root references (transitively) must be covered by a role of the caller too, or the run is refused before anything is built from it: 403
    // REFERENCE_NOT_READABLE, a message that names nothing of the other entity (KD-045). A client that goes away cancels its runs (`request.signal`).
    let run: Awaited<ReturnType<typeof emitTargetsForEntity>>;
    try {
      run = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft", entityReader(api.principal.assignments), { signal: request.signal });
    } finally {
      share();
    }
    // The compiler refused runs because its queue is full: the answer is "try again", not an emission verdict.
    if (run.busy) return apiBusy();
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

    const typespec = generateTypeSpec(compileEntity(prismaEntity, prismaFields));

    // A run that completed with no invalid target is an emission (a preview: nothing is stored). Its owner and the endpoints of `emission.completed`
    // hear of it, after the answer. Scheduled only once the answer is built, so a failed build is never recorded as an emission.
    if (results.length > 0 && invalidCount === 0) {
      runAfterResponse("Emission notification", () => notifyEntityEmitted(id, results.length, api.ctx, "preview"));
    }

    return apiSuccess(
      {
        entityId: id,
        entityName: entity.name,
        version: entity.version,
        typespec,
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
}, { rateLimit: true });

