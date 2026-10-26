/**
 * The reference closure a PUBLISH of an entity is judged against (multi-entity emission, Task 8).
 *
 * Publishing X freezes X's saved draft, so X is read from its current rows; everything X references (transitively) is read at its
 * latest PUBLISHED version, or at the version a field pinned, and never at a draft: a published X can never contain draft content of
 * a referenced entity. When any member cannot be resolved that way the publish is blocked, and the message names the entity:
 * - a member that has never been published (a published version needs a published version to refer to),
 * - a pin whose version no longer exists,
 * - a bare-name reference that matches several entities (nothing is guessed), or a closure over the size cap.
 *
 * On success the closure also yields the record the publish stores: the exact version of every referenced entity it used.
 */

import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { closureFailure } from "@/lib/emission/closure-generation";
import { loadReferenceClosure, type ClosureError, type ClosureReader, type ReferenceClosure } from "@/lib/references/closure";
import { describeEntityRef, type EntityRef } from "@/lib/references/entity-reference";
import type { Result } from "@/types/result";
import type { ReferencedVersion } from "./referenced-versions";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Why a publish cannot proceed, as the planner shows it. `entityId` is set when the message is about one specific entity.
 * `details` is the closure's own structure for the failure (`closureFailure(error).details`): for `AMBIGUOUS_REFERENCE`
 * `{ field, name, candidates, entityId, fieldId }` (the entity and field row that HOLD the reference, a member as often as the root:
 * where the pick is written), for `PIN_NOT_FOUND` `{ field, ref, version }`, for `NEVER_PUBLISHED` `{ ref }`.
 */
export type PublishClosureBlocker = {
  code: ClosureError["code"] | "DRAFT_REFERENCE";
  message: string;
  entityId?: string;
  details?: object;
};

export type PublishClosure = {
  closure: ReferenceClosure;
  /** Every entity of the closure except the root, in closure order, with the version used and whether a field pinned it. */
  referencedVersions: ReferencedVersion[];
};

/** `domain / product / entity`: how a person reads a qualified name (the stored form is `domain/product/entity`). */
const describeRef = (ref: EntityRef): string => describeEntityRef(ref);

/** A closure error as a publish blocker. The wording follows the generate path's (`closureFailure`), except where a publish needs its own. */
export function publishBlockerFor(error: ClosureError, rootName: string): PublishClosureBlocker {
  const failure = closureFailure(error);
  const details = failure.details ? { details: failure.details } : {};
  switch (error.code) {
    case "NEVER_PUBLISHED":
      return {
        code: error.code,
        message: `Publish ${error.ref.entity} first: ${describeRef(error.ref)} has never been published, and a published ${rootName} can only use published versions of what it references.`,
        ...(error.ref.entityId ? { entityId: error.ref.entityId } : {}),
        ...details,
      };
    case "PIN_NOT_FOUND":
      return { code: error.code, message: failure.message, ...(error.ref.entityId ? { entityId: error.ref.entityId } : {}), ...details };
    default:
      return { code: error.code, message: failure.message, ...details };
  }
}

/**
 * Loads the closure of `entity` for a publish: the entity at its saved rows, every member published or pinned. `entity.tenantId` is
 * the entity's own tenant (a publish never reaches across tenants; the caller already proved the entity is the user's). Never throws
 * for a domain failure.
 *
 * `opts.reader` (KD-045) is who may read what: a member the publisher's roles do not cover blocks the publish (`REFERENCE_NOT_READABLE`, a message
 * that names nothing of it) before its published content is read, so it never reaches the combined source that is compiled nor the record stored.
 */
export async function loadPublishClosure(
  db: Db,
  entity: { id: string; tenantId: string; name: string },
  opts?: { maxEntities?: number; reader?: ClosureReader }
): Promise<Result<PublishClosure, PublishClosureBlocker>> {
  const loaded = await loadReferenceClosure(db, entity.tenantId, entity.id, "published", { rootAtDraft: true, ...opts });
  if (!loaded.success) return { success: false, error: publishBlockerFor(loaded.error, entity.name) };

  const closure = loaded.data;
  const members = closure.entities.filter((member) => member.entityId !== closure.root.entityId);
  // Cannot happen in published mode (a member is published or pinned or the load fails); it is the invariant a published X rests on,
  // so a violation blocks the publish instead of freezing a draft.
  const draft = members.find((member) => member.source === "draft" || member.version === undefined);
  if (draft) {
    return {
      success: false,
      error: {
        code: "DRAFT_REFERENCE",
        message: `${describeRef(draft.ref)} resolved to unpublished content, so ${entity.name} cannot be published against it. Publish it first.`,
        entityId: draft.entityId,
      },
    };
  }
  return {
    success: true,
    data: {
      closure,
      referencedVersions: members.map((member) => ({
        ref: { ...member.ref },
        version: member.version as string,
        pinned: member.source === "pinned",
      })),
    },
  };
}
