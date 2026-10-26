"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { failureOf, inActiveTenant, notFoundFailure, unexpectedFailure } from "@/lib/action-context";
import { getEffectiveRole } from "@/services/rbac.service";
import { listEntityVersions, previewPublish, publishEntity } from "@/services/entity-version.service";
import { needsReferenceOf, type PublishAnalysis, type PublishBlocker, type PublishNeedsReference } from "@/lib/entity-versioning/publish-plan";
import { isBumpKind, MAX_CHANGE_SUMMARY, type EntityVersionSummary, type PublishInput } from "@/lib/entity-versioning/types";
import type { ServiceContext } from "@/types/service-context";

/** Same role resolution as actions.ts (fail-closed to VIEWER). */
async function serviceContext(userId: string): Promise<ServiceContext> {
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

/**
 * Every action here addresses an entity by a bare id from the client and the services trust it, so the entity must belong to
 * the caller's ACTIVE tenant (`inActiveTenant`): a foreign id gets the same NOT_FOUND as a missing one, before anything is
 * read, previewed or published. An unexpected throw is logged and answered generically; a service failure with an opaque
 * code (`DB_ERROR` / `INTERNAL_ERROR`) loses its raw text (`failureOf`).
 */
export async function getPublishPreviewAction(
  entityId: string
): Promise<{ success: true; preview: PublishAnalysis } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    if (!(await inActiveTenant("entity", entityId))) return { ...notFoundFailure("Entity") }; // TODO(access-control task 5): tenant-only guard, asks no role: move to authorizeSubject(action, { kind, id }) (resolves the row, needs it in the ACTIVE tenant and a covering role)
    const res = await previewPublish(entityId, await serviceContext(session.user.id));
    if (!res.success) return { ...failureOf(res.error, "getPublishPreviewAction") };
    return { success: true, preview: res.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getPublishPreviewAction", e) };
  }
}

export async function publishEntityAction(
  entityId: string,
  input: PublishInput
): Promise<{ success: true; version: EntityVersionSummary } | { error: string; code?: string; needsReference?: PublishNeedsReference }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const raw: Partial<PublishInput> = typeof input === "object" && input !== null ? input : {};
  if (raw.bump !== undefined && !isBumpKind(raw.bump)) {
    return { error: "bump must be MAJOR or MINOR", code: "VALIDATION_ERROR" };
  }
  if (
    raw.changeSummary !== undefined &&
    (typeof raw.changeSummary !== "string" || raw.changeSummary.length > MAX_CHANGE_SUMMARY)
  ) {
    return { error: `Change summary must be at most ${MAX_CHANGE_SUMMARY} characters`, code: "VALIDATION_ERROR" };
  }

  try {
    if (!(await inActiveTenant("entity", entityId))) return { ...notFoundFailure("Entity") }; // TODO(access-control task 5): tenant-only guard, asks no role: move to authorizeSubject(action, { kind, id }) (resolves the row, needs it in the ACTIVE tenant and a covering role)
    const res = await publishEntity(
      entityId,
      { bump: raw.bump, changeSummary: raw.changeSummary },
      await serviceContext(session.user.id)
    );
    if (!res.success) {
      // A publish blocked by an ambiguous bare-name reference also answers WHICH pick it needs (`needsReference`, the shape
      // `generateSchemaAction` answers), so the UI can open the pick dialog instead of showing a sentence.
      const blockers = (res.error.details as { blockers?: PublishBlocker[] } | undefined)?.blockers;
      const needsReference = Array.isArray(blockers) ? needsReferenceOf(blockers) : undefined;
      return { ...failureOf(res.error, "publishEntityAction"), ...(needsReference ? { needsReference } : {}) };
    }
    revalidatePath("/schemas");
    return { success: true, version: res.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("publishEntityAction", e) };
  }
}

export async function listEntityVersionsAction(
  entityId: string
): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    if (!(await inActiveTenant("entity", entityId))) return { ...notFoundFailure("Entity") }; // TODO(access-control task 5): tenant-only guard, asks no role: move to authorizeSubject(action, { kind, id }) (resolves the row, needs it in the ACTIVE tenant and a covering role)
    const res = await listEntityVersions(entityId, await serviceContext(session.user.id));
    if (!res.success) return { ...failureOf(res.error, "listEntityVersionsAction") };
    return { success: true, versions: res.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("listEntityVersionsAction", e) };
  }
}
