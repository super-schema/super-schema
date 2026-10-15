// src/lib/action-context.ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ActionResult } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export const NOT_AUTHENTICATED = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" } as const satisfies ActionResult<never>;

/** Same role resolution as version-actions.ts: authenticated user, effective role fail-closed to VIEWER (D16). */
export async function getActionContext(): Promise<ServiceContext | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const role = await getEffectiveRole(userId, null, { userId, userRole: "VIEWER", prisma });
  return { userId, userRole: role.success && role.data ? role.data : "VIEWER", prisma };
}

export function toActionResult<T>(result: Result<T>): ActionResult<T> {
  if (result.success) return { success: true, data: result.data };
  const { message, code, details } = result.error;
  return details ? { success: false, error: message, code, details } : { success: false, error: message, code };
}
