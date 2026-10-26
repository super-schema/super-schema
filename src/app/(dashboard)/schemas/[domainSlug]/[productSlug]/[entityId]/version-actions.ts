"use server";

import { revalidatePath } from "next/cache";
import { contextOf, failureOf, guardSubject, unexpectedFailure } from "@/lib/action-context";
import { listEntityVersions, previewPublish, publishEntity } from "@/services/entity-version.service";
import { needsReferenceOf, type PublishAnalysis, type PublishBlocker, type PublishNeedsReference } from "@/lib/entity-versioning/publish-plan";
import { isBumpKind, MAX_CHANGE_SUMMARY, type EntityVersionSummary, type PublishInput } from "@/lib/entity-versioning/types";

/**
 * Every action here addresses an entity by a bare id from the client and the services trust it, so the guard comes first
 * (`guardSubject`): the entity must be in the caller's ACTIVE tenant and the caller's role must cover it for the action (`entity.read` to
 * list and preview, `entity.publish` to publish), else the same NOT_FOUND as a missing entity or a generic FORBIDDEN, before anything is read,
 * previewed or published. An unexpected throw is logged and answered generically; a service failure with an opaque code (`DB_ERROR` /
 * `INTERNAL_ERROR`) loses its raw text (`failureOf`).
 */
export async function getPublishPreviewAction(
  entityId: string
): Promise<{ success: true; preview: PublishAnalysis } | { error: string; code?: string }> {
  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const res = await previewPublish(entityId, contextOf(access.principal));
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
    const access = await guardSubject("entity.publish", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const res = await publishEntity(entityId, { bump: raw.bump, changeSummary: raw.changeSummary }, contextOf(access.principal));
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
): Promise<{ success: true; versions: EntityVersionSummary[] } | { error: string; code?: string }> {
  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const res = await listEntityVersions(entityId, contextOf(access.principal));
    if (!res.success) return { ...failureOf(res.error, "listEntityVersionsAction") };
    return { success: true, versions: res.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("listEntityVersionsAction", e) };
  }
}
