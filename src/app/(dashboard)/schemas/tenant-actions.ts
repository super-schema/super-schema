"use server";

import { auth } from "@/lib/auth";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant";

/** Switch the active tenant (org label) for the current browser. */
export async function setActiveTenantAction(tenantId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) {
    return { error: "Tenant not found" };
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
