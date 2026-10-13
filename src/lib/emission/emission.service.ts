/**
 * Emission service — orchestrates the full emission pipeline.
 *
 * Takes an entity ID, loads entity + fields from Prisma, then runs every
 * enabled schema target through the real TypeSpec compiler.
 */

import { prisma } from "@/lib/db";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { compileEntity } from "@/lib/compiler/compiler.service";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { EmissionResult, TargetOutput } from "./emission.types";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";

// Re-export the pure function for convenience
export { emitFromData } from "./emit-from-data";

// ---------------------------------------------------------------------------
// Public API — DB-backed emission
// ---------------------------------------------------------------------------

/**
 * Run the full emission pipeline for an entity: every enabled schema target,
 * through the real TypeSpec compiler (every target is `runtime: "typespec-cli"`
 * as of 2026-10-12 — see src/emitters/index.ts for why the native-only
 * `emitFromData()` this used to delegate to is no longer sufficient here).
 */
export async function emitEntity(entityId: string): Promise<EmissionResult> {
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
  const prismaEntity: PrismaEntityInput = {
    id: entity.id,
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

  await Promise.all(
    enabledTargets.map(async (target) => {
      const result = await emitOfficialTypeSpecTargetFromData(prismaEntity, prismaFields, target.key);
      targets[target.key] = {
        name: target.key,
        targetFormat: target.targetFormat,
        output: result.output,
        isValid: result.validationStatus === "VALID",
        validationStatus: result.validationStatus,
        warnings: result.warnings.map((message) => ({ message })),
        errors: result.errors,
      };
    })
  );

  const validCount = Object.values(targets).filter((t) => t.validationStatus === "VALID").length;
  const invalidCount = Object.values(targets).filter((t) => t.validationStatus === "INVALID").length;
  const warningCount = enabledTargets.length - validCount - invalidCount;

  return {
    typespec: generateTypeSpec(compileEntity(prismaEntity, prismaFields)),
    targets,
    success: invalidCount === 0,
    summary: {
      totalTargets: enabledTargets.length,
      validCount,
      warningCount,
      invalidCount,
    },
  };
}

