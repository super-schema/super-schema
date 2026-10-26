"use server";

import { prisma } from "@/lib/db";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { readableScopes } from "@/lib/access";
import { omitSchemaVersions } from "@/lib/access/schema-version-redaction";
import { guardActiveTenant, guardSubject, unexpectedFailure } from "@/lib/action-context";
import { isPlainObject } from "@/lib/editable-fields";
import { RetentionPolicySchema } from "@/types/schemas/retention-policy.schema";
import { domainLabel } from "@/lib/entity-placement";
import { metadataChangesDraft, withSourceStale } from "@/lib/entity-versioning/draft-state";

/**
 * The entities of the ACTIVE tenant that the caller may read (`entity.read`: the retention page is a read of entities): they must hold a role in the
 * tenant (`tenant.access`), and a tenant-wide role lists every entity (an Enterprise, domain- or product-level one all carry their tenant) while a
 * domain- or product-scoped role lists only the entities under its domains and products, in the QUERY (never a tenant-level entity).
 */
export async function getEntitiesForRetentionAction() {
  try {
    const access = await guardActiveTenant("tenant.access", { label: "Entities" });
    if (!access.allowed) return { error: access.refusal.error, entities: [] };
    const scopes = readableScopes(access.principal.assignments, "entity.read", access.resource.tenantId);

    const entities = await prisma.entity.findMany({
      where: scopes.all
        ? { tenantId: access.resource.tenantId }
        : { tenantId: access.resource.tenantId, OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] },
      select: {
        id: true,
        name: true,
        metadata: true,
        domain: { select: { name: true } },
        fields: { select: { name: true, type: true, classification: true } },
      },
      orderBy: { name: "asc" },
    });

    return {
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        domainName: domainLabel(e.domain),
        // The retention table reads the retention policy; the stored generated schemas stay out (they hold the files of whole closures: KD-046).
        metadata: omitSchemaVersions(e.metadata) as Record<string, unknown> | null,
        fields: e.fields.map((f) => ({ name: f.name, type: f.type, classification: f.classification })),
      })),
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getEntitiesForRetentionAction", e), entities: [] };
  }
}

/**
 * Edit an entity's retention policy: `retention.write` (a steward's act) over the entity, judged BEFORE the entity is read. The entity must lie in
 * the ACTIVE tenant and the caller's roles must cover it; a missing entity, one of another tenant and one nothing of theirs covers all answer the
 * same `Entity not found`, too low a role a generic refusal. The payload is checked after, so nobody learns what a valid policy looks like
 * without a role over the entity.
 */
export async function updateRetentionPolicyAction(
  entityId: string,
  retentionPolicy: Record<string, unknown>
) {
  try {
    const access = await guardSubject("retention.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    return await saveRetentionPolicy(entityId, retentionPolicy);
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateRetentionPolicyAction", e) };
  }
}

/** The write behind `updateRetentionPolicyAction`, after the guard. */
async function saveRetentionPolicy(entityId: string, retentionPolicy: Record<string, unknown>) {
  // `retentionPolicy` is stored as metadata: only a plain object is a policy (a Date or Map would still mark the draft changed).
  if (!isPlainObject(retentionPolicy)) return { error: "The retention policy must be an object", code: "VALIDATION_ERROR" };
  // The policy is validated HERE, not only in the editor: `{ period: 0.5 }` used to be stored, and a stored policy that the schema refuses
  // reads as "No template" (and as nothing) wherever the schema is applied. What is stored is the policy as the schema reads it.
  const checked = RetentionPolicySchema.safeParse(retentionPolicy);
  if (!checked.success) return { error: checked.error.issues[0]?.message ?? "The retention policy is not valid", code: "VALIDATION_ERROR" };
  const policy = checked.data;

  try {
    // The guard above proved the entity exists, lies in the active tenant and is the caller's to edit.
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found", code: "NOT_FOUND" as const };

    const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};
    const mergedMeta = { ...existingMeta, retentionPolicy: policy };
    // A changed policy is a draft edit and marks the stored TypeSpec source stale (R45); an unchanged
    // policy leaves the flags alone, but never lets an already-stale source go fresh.
    const changesDraft = metadataChangesDraft(existingMeta, mergedMeta);
    const updatedMeta = withSourceStale(existingMeta, mergedMeta, changesDraft);

    await prisma.entity.update({
      where: { id: entityId },
      data: {
        metadata: updatedMeta as Prisma.InputJsonValue,
        ...(changesDraft && { hasUnpublishedChanges: true }),
      },
    });

    revalidatePath("/schemas");
    revalidatePath("/governance/retention");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateRetentionPolicyAction", e) };
  }
}
