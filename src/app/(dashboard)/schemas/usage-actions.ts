"use server";

import { can } from "@/lib/access";
import { authorizeActiveTenant, authorizeSubject, contextOf, toActionResult } from "@/lib/action-context";
import { parseUsageSubject, type UsageList, type UsageSubject } from "@/lib/events/usage";
import { findUsages } from "@/services/events/usage.service";
import type { ActionResult } from "@/types/action-result";
import { ok } from "@/types/result";

/**
 * Spec 18.9 "Who uses X?" — read-only (`usage.read`, a viewer's act over the subject): nothing is revalidated. The policy is asked over the
 * SUBJECT first (the entity or event the lookup is about, read from its row: it must lie in the ACTIVE tenant and the caller's roles must
 * cover it; a missing, foreign or unseen subject all answer the same NOT_FOUND). The tenant is the server-resolved active tenant, never a
 * client value. The referrers the lookup lists are restricted to the ones the caller may read themselves (an event, trait or entity of a
 * domain or product their roles do not cover is not named); the subject id is untrusted and the service rejects a malformed one.
 *
 * The answer is `{ rows, truncated }`: `findUsages` returns an array carrying `truncated` as a non-index property, which the
 * action serializer drops, so the flag is copied into the object that is sent.
 */
export async function listUsagesAction(subject: UsageSubject): Promise<ActionResult<UsageList>> {
  const parsed = parseUsageSubject(subject);
  if (!parsed.success) {
    // Nothing to read, nothing to look up: but whoever is not signed in, or holds no role here, is told no more than that.
    const who = await authorizeActiveTenant("usage.read");
    return toActionResult(who.success ? parsed : { success: false, error: who.error });
  }
  const target = parsed.data;
  const access = await authorizeSubject("usage.read", target.kind === "entity" ? { kind: "entity", id: target.entityId } : { kind: "event", id: target.eventId });
  if (!access.success) return toActionResult({ success: false, error: access.error });

  const { principal, resource } = access.data;
  const result = await findUsages(subject, contextOf(principal), resource.tenantId, (kind, place) =>
    can(principal.assignments, kind === "entity" ? "entity.read" : kind === "event" ? "event.read" : "trait.read", { tenantId: resource.tenantId, ...place })
  );
  // A DB_ERROR message is driver text (hosts, constraint names); the browser only gets a generic one.
  if (!result.success && result.error.code === "DB_ERROR") {
    return { success: false, error: "Could not load usages. Try again.", code: "DB_ERROR" };
  }
  return toActionResult(result.success ? ok({ rows: [...result.data], truncated: result.data.truncated === true }) : result);
}
