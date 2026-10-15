// src/lib/action-context.ts
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { AuditUserMissingError } from "@/lib/audit";
import { resolveCurrentUserId } from "@/lib/current-user";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const NOT_AUTHENTICATED = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" } as const satisfies ActionResult<never>;

/**
 * Same user + role resolution as the data-type / API actions: the session user is mapped to a `User` row
 * by id, then by email (`resolveCurrentUserId`), and the effective role fails closed to VIEWER (D16).
 * Returns null when there is no session or the session points at a user that no longer exists
 * (a stale session is treated as not authenticated — the caller signs in again).
 */
export async function getActionContext(): Promise<ServiceContext | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  let userId: string;
  try {
    userId = await resolveCurrentUserId(session.user);
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return null;
    throw e;
  }
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

export function toActionResult<T>(result: Result<T>): ActionResult<T> {
  if (result.success) return { success: true, data: result.data };
  const { message, code, details, suggestedFix } = result.error;
  return {
    success: false,
    error: message,
    code,
    ...(details && { details }),
    ...(suggestedFix && { suggestedFix }),
  };
}

/**
 * The shared shape of every mutating events server action: authenticate, run the service call, and
 * revalidate `/schemas` (layout) on success only (`staleTimes.dynamic = 30` would otherwise serve stale pages).
 * Read-only actions use `getActionContext` + `toActionResult` directly and never revalidate.
 */
export async function runMutation<T>(run: (ctx: ServiceContext) => Promise<Result<T>>): Promise<ActionResult<T>> {
  const ctx = await getActionContext();
  if (!ctx) return NOT_AUTHENTICATED;
  const result = await run(ctx);
  if (result.success) revalidatePath("/schemas", "layout");
  return toActionResult(result);
}
