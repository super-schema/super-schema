"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@/generated/prisma/client";
import { domainLabel } from "@/lib/entity-placement";
import { metadataChangesDraft, withSourceStale } from "@/lib/entity-versioning/draft-state";

export async function getEntitiesForRetentionAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated", entities: [] };
  }

  try {
    const entities = await prisma.entity.findMany({
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
  } catch {
    return { error: "Failed to load entities", entities: [] };
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

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found" };

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
    const message = e instanceof Error ? e.message : "Failed to update retention policy";
    return { error: message };
  }
}
