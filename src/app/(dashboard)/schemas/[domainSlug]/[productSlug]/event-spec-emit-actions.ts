"use server";

import { getActiveTenantId } from "@/lib/active-tenant";
import { getActionContext, NOT_AUTHENTICATED, toActionResult } from "@/lib/action-context";
import { parseVersionParam } from "@/features/events/event-specs/version-param";
import { emitEventSpec, type EmitTarget, type EventSpecEmission } from "@/services/events/event-spec-emit.service";
import type { ServiceContext } from "@/types/service-context";
import type { ActionResult } from "@/types/action-result";

const UNEXPECTED_FAILURE = {
  success: false,
  error: "The event spec could not be read or emitted. Try again; if it keeps failing, contact an administrator.",
  code: "INTERNAL_ERROR",
} as const satisfies ActionResult<never>;

/** One fixed answer for a spec of another tenant, of another product (draft reads), or that does not exist: no id oracle, no details. */
const SPEC_NOT_FOUND = { success: false, error: "Event spec not found", code: "NOT_FOUND" } as const satisfies ActionResult<never>;

/**
 * `emitEventSpec` reads by id and trusts the row, so every call is scoped here first (R67), before anything is rendered or
 * read from the spec: the spec must be in the server-resolved active tenant and, when `productId` is given, owned by that product.
 */
async function inScope(ctx: ServiceContext, specId: unknown, productId?: unknown): Promise<boolean> {
  if (typeof specId !== "string" || specId === "") return false;
  if (productId !== undefined && (typeof productId !== "string" || productId === "")) return false;
  const tenantId = await getActiveTenantId();
  const row = await ctx.prisma.eventSpec.findFirst({ where: { id: specId, tenantId, ...(productId !== undefined && { productId }) }, select: { id: true } });
  return row !== null;
}

/** Read-style action: authenticate, scope, call the service, never revalidate. An unexpected throw is logged and returned generically. */
async function emitAction(specId: string, ownerProductId: string | undefined, target: EmitTarget): Promise<ActionResult<EventSpecEmission>> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return NOT_AUTHENTICATED;
    if (!(await inScope(ctx, specId, ownerProductId))) return SPEC_NOT_FOUND;
    return toActionResult(await emitEventSpec(specId, target, ctx));
  } catch (e: unknown) {
    console.error("[event-spec-emit-actions] unexpected failure:", e);
    return UNEXPECTED_FAILURE;
  }
}

/**
 * Read-only: no revalidation. Draft emission renders artifacts on demand (D9) and validates with @asyncapi/parser. A draft is
 * private to its product: `productId` (the page's owning product, same position as in the publish actions) must own the spec.
 */
export async function emitEventSpecDraftAction(specId: string, productId: string): Promise<ActionResult<EventSpecEmission>> {
  return emitAction(specId, productId ?? "", { draft: true });
}

/**
 * A published version is readable by the whole tenant (other products consume it, read-only), so this one is tenant-scoped only.
 * The label is bounded before anything is read (an out-of-range one would otherwise reach the driver): it is rejected the same way
 * whichever spec it is asked of, so it tells nothing about what exists.
 */
export async function getEventSpecVersionDocumentAction(specId: string, label: string): Promise<ActionResult<EventSpecEmission>> {
  const parsed = parseVersionParam(label);
  if (!parsed) return { success: false, error: "The version must be MAJOR.MINOR, e.g. 2.1", code: "VALIDATION_ERROR" };
  return emitAction(specId, undefined, { versionLabel: `${parsed.major}.${parsed.minor}` });
}
