/**
 * Emission service — orchestrates the full emission pipeline.
 *
 * Takes an entity ID, loads entity + fields from Prisma, then runs every
 * enabled schema target through the real TypeSpec compiler.
 */

import { prisma } from "@/lib/db";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { EmissionResult, TargetOutput } from "./emission.types";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { getSchemaTargetCatalog, type SchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { baseNameOf, loadInheritedFields, loadReferenceClosure, withInheritedFields, withoutSchemaVersions, type ClosureReader, type ReferenceClosure, type ResolveMode } from "@/lib/references/closure";
import type { ServiceError } from "@/types/result";
import type { SchemaVersionResolution } from "@/types/schema-version";
import { closureFailure, describeResolution, emitClosureTarget, type ClosureTargetResult } from "./closure-generation";

// Re-export the pure function for convenience
export { emitFromData } from "./emit-from-data";

type DbClient = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Public API — DB-backed emission
// ---------------------------------------------------------------------------

export interface TargetEmission {
  target: SchemaTargetDefinition;
  /** `files` is set for the closure targets that emitted; the DB targets never have it. */
  result: ClosureTargetResult;
}

export interface EntityTargetsEmission {
  results: TargetEmission[];
  /** Which version of each entity the closure targets used; absent when no closure was loaded (only DB targets) or it was refused. */
  resolution?: SchemaVersionResolution;
  /**
   * Set when the reference closure could not be built (an ambiguous bare-name reference, a pin that is gone, an entity that was never
   * published in `published` mode, too many entities). Every closure target is then an INVALID result carrying the message, and the DB
   * targets are emitted as usual. A non-interactive caller (API routes, CI) returns this as a structured error.
   */
  refusal?: ServiceError;
}

/**
 * Emits `targets` for one entity. The closure targets (JSON Schema, OpenAPI 3, Protobuf, Avro, Java POJO) share ONE reference closure
 * loaded here, tenant-scoped to the entity's own tenant, and write one file per entity of it; the DB targets keep today's path (the
 * entity alone, a reference stays a plain column) and ignore `mode`.
 *
 * Which inputs are read by whom: a closure target reads NOTHING of `entity` / `fields` except `entity.id` and `entity.tenantId` (the root
 * and the tenant of the closure): the root and every member are read from the database by the closure, in `mode`. `entity` and `fields`
 * are the stand-alone input of the DB targets only (and are not read at all when only closure targets are asked for).
 *
 * `mode` decides what an unpinned reference resolves to: `draft` the latest saved definition (the output is a preview), `published`
 * the latest published version (never a draft). Loading and emitting never write: a legacy name-only reference that resolved is not
 * upgraded here. Never throws for a domain failure.
 *
 * `reader` (KD-045) is who may read what: the closure refuses (`refusal`, code `REFERENCE_NOT_READABLE`) when it reaches an entity the caller's
 * roles do not cover, before any source or file is built from it. It is REQUIRED, so a new caller has to say whose roles decide
 * (`entityReader(principal.assignments)`); the entity itself is the caller's, authorized before this runs.
 */
export async function emitTargetsForEntity(
  db: DbClient,
  entity: PrismaEntityInput & { tenantId: string },
  fields: PrismaFieldInput[],
  targets: SchemaTargetDefinition[],
  mode: ResolveMode,
  reader: ClosureReader
): Promise<EntityTargetsEmission> {
  let closure: ReferenceClosure | undefined;
  let refusal: ServiceError | undefined;
  if (targets.some((target) => target.closureEmission)) {
    const loaded = await loadReferenceClosure(db, entity.tenantId, entity.id, mode, { reader });
    if (loaded.success) closure = loaded.data;
    else refusal = closureFailure(loaded.error);
  }

  // A DB target has no inheritance: an entity that extends another gets the columns of its bases (the latest of each, in `mode`).
  let dbFields = fields;
  let dbRefusal: ServiceError | undefined;
  if (targets.some((target) => !target.closureEmission) && baseNameOf(entity.metadata) !== undefined) {
    const inherited = await loadInheritedFields(db, entity.tenantId, entity.id, entity.metadata, mode, { reader });
    if (inherited.success) dbFields = withInheritedFields(fields, inherited.data.fields);
    else dbRefusal = closureFailure(inherited.error);
  }

  const results = await Promise.all(
    targets.map(async (target): Promise<TargetEmission> => {
      if (!target.closureEmission) {
        if (dbRefusal) return { target, result: { output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: dbRefusal.message }] } };
        // The stored schema versions are never emission input (and can be large): the DB target gets the entity without them.
        const standalone = { ...entity, metadata: withoutSchemaVersions(entity.metadata) };
        return { target, result: await emitOfficialTypeSpecTargetFromData(standalone, dbFields, target.key) };
      }
      if (!closure) {
        const message = refusal?.message ?? "The reference closure could not be built.";
        return { target, result: { output: "", validationStatus: "INVALID", warnings: [], errors: [{ message }] } };
      }
      return { target, result: await emitClosureTarget(closure, target.key) };
    })
  );
  return { results, ...(closure ? { resolution: describeResolution(closure, mode) } : {}), ...(refusal ? { refusal } : {}) };
}

/**
 * Run the full emission pipeline for an entity: every enabled schema target,
 * through the real TypeSpec compiler (every target is `runtime: "typespec-cli"`
 * as of 2026-10-12 — see src/emitters/index.ts for why the native-only
 * `emitFromData()` this used to delegate to is no longer sufficient here).
 * The closure targets emit the entity together with everything it references (draft mode, see `emitTargetsForEntity`), limited to what `reader`
 * says the caller may read (KD-045: otherwise the run is refused).
 */
export async function emitEntity(entityId: string, reader: ClosureReader): Promise<EmissionResult> {
  // 1. Load entity + fields
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: { domain: true },
  });

  if (!entity) {
    throw new Error(`Entity not found: ${entityId}`);
  }

  const fields = await prisma.field.findMany({
    where: { entityId },
    orderBy: { sortOrder: "asc" },
  });

  // 2. Map to input shapes
  const prismaEntity: PrismaEntityInput & { tenantId: string } = {
    id: entity.id,
    tenantId: entity.tenantId,
    name: entity.name,
    description: entity.description,
    status: entity.status,
    version: entity.version,
    domainId: entity.domainId,
    metadata: entity.metadata,
    domain: entity.domain
      ? { id: entity.domain.id, name: entity.domain.name, slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-") }
      : null,
  };

  const prismaFields: PrismaFieldInput[] = fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    precision: f.precision,
    scale: f.scale,
    nullable: f.nullable,
    isKey: f.isKey,
    fieldNumber: f.fieldNumber,
    description: f.description,
    classification: f.classification,
    aliases: f.aliases,
    decorators: f.decorators,
    sortOrder: f.sortOrder,
  }));

  // 3. Run every enabled target through the real compiler
  const enabledTargets = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab);
  const targets: Record<string, TargetOutput> = {};

  const emission = await emitTargetsForEntity(prisma, prismaEntity, prismaFields, enabledTargets, "draft", reader);
  for (const { target, result } of emission.results) {
    targets[target.key] = {
      name: target.key,
      targetFormat: target.targetFormat,
      output: result.output,
      ...(result.files ? { files: result.files } : {}),
      // A WARNING target (e.g. Avro enum symbols that had to be renamed) produced a usable schema: valid, with warnings —
      // the same meaning `emitFromData` gives `isValid` (the native emitters set it from `validate()`, never from warnings).
      isValid: result.validationStatus !== "INVALID",
      validationStatus: result.validationStatus,
      warnings: result.warnings.map((message) => ({ message })),
      errors: result.errors,
    };
  }

  const validCount = Object.values(targets).filter((t) => t.validationStatus === "VALID").length;
  const invalidCount = Object.values(targets).filter((t) => t.validationStatus === "INVALID").length;
  const warningCount = enabledTargets.length - validCount - invalidCount;

  return {
    typespec: generateTypeSpec(compileEntity(prismaEntity, prismaFields)),
    targets,
    ...(emission.refusal ? { refusal: emission.refusal } : {}),
    success: invalidCount === 0,
    summary: {
      totalTargets: enabledTargets.length,
      validCount,
      warningCount,
      invalidCount,
    },
  };
}
