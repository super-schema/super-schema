"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { getActiveTenantId } from "@/lib/active-tenant";
import { isInActiveTenant, notFoundFailure, unexpectedFailure } from "@/lib/action-context";
import { isPlainObject } from "@/lib/editable-fields";
import { domainLabel } from "@/lib/entity-placement";
import { metadataChangesDraft, withSourceStale } from "@/lib/entity-versioning/draft-state";

export async function getEntitiesForRetentionAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated", entities: [] };
  }

  try {
    // The entities of the ACTIVE tenant (the same scope `updateRetentionPolicyAction` enforces): an Enterprise, domain- or
    // product-level entity all carry their tenant, so the default tenant still lists everything it owns.
    const entities = await prisma.entity.findMany({
      where: { tenantId: await getActiveTenantId() },
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
        metadata: e.metadata as Record<string, unknown> | null,
        fields: e.fields.map((f) => ({ name: f.name, type: f.type, classification: f.classification })),
      })),
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getEntitiesForRetentionAction", e), entities: [] };
  }
}

export async function updateRetentionPolicyAction(
  entityId: string,
  retentionPolicy: Record<string, unknown>
) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  // `retentionPolicy` is stored as metadata: only a plain object is a policy (a Date or Map would still mark the draft changed).
  if (!isPlainObject(retentionPolicy)) return { error: "The retention policy must be an object", code: "VALIDATION_ERROR" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true, tenantId: true },
    });
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    if (!entity || !(await isInActiveTenant(entity.tenantId))) return { ...notFoundFailure("Entity") };

    const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};
    const mergedMeta = { ...existingMeta, retentionPolicy };
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
