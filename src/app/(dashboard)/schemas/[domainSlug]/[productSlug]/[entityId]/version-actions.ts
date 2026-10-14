"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { getEffectiveRole } from "@/services/rbac.service";
import { listEntityVersions, previewPublish, publishEntity } from "@/services/entity-version.service";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import { isBumpKind, type EntityVersionSummary, type PublishInput } from "@/lib/entity-versioning/types";
import type { ServiceContext } from "@/types/service-context";

const MAX_CHANGE_SUMMARY = 500;

/** Same role resolution as actions.ts (fail-closed to VIEWER). */
async function serviceContext(userId: string): Promise<ServiceContext> {
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

export async function getPublishPreviewAction(
  entityId: string
): Promise<{ success: true; preview: PublishAnalysis } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const res = await previewPublish(entityId, await serviceContext(session.user.id));
  if (!res.success) return { error: res.error.message };
  return { success: true, preview: res.data };
}

export async function publishEntityAction(
  entityId: string,
  input: PublishInput
): Promise<{ success: true; version: EntityVersionSummary } | { error: string; code?: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  if (input.bump !== undefined && !isBumpKind(input.bump)) {
    return { error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" };
  }
  if (
    input.changeSummary !== undefined &&
    (typeof input.changeSummary !== "string" || input.changeSummary.length > MAX_CHANGE_SUMMARY)
  ) {
    return { error: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`, code: "VALIDATION_ERROR" };
  }

  const res = await publishEntity(
    entityId,
    { bump: input.bump, changeSummary: input.changeSummary },
    await serviceContext(session.user.id)
  );
  if (!res.success) return { error: res.error.message, code: res.error.code };
  revalidatePath("/schemas");
  return { success: true, version: res.data };
}

export async function listEntityVersionsAction(
  entityId: string
): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const res = await listEntityVersions(entityId, await serviceContext(session.user.id));
  if (!res.success) return { error: res.error.message };
  return { success: true, versions: res.data };
}
