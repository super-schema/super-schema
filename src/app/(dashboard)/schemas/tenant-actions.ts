"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant";
import { authorizeTenant } from "@/lib/action-context";

const TENANT_NOT_FOUND = { error: "Tenant not found" } as const;

/**
 * Switch the active tenant for the current browser. Only to a tenant the user may access (a role at any depth in it; a global
 * administrator: any): a refusal answers EXACTLY as a tenant that does not exist does, so ids cannot be probed for which tenants exist.
 */
export async function setActiveTenantAction(tenantId: string) {
  const allowed = await authorizeTenant("tenant.access", tenantId);
  if (!allowed.success) {
    return allowed.error.code === "UNAUTHORIZED" ? { error: "You must be logged in" } : { ...TENANT_NOT_FOUND };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) {
    return { ...TENANT_NOT_FOUND };
  }

  const store = await cookies();
  store.set(ACTIVE_TENANT_COOKIE, tenant.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/schemas");
  return { success: true };
}
