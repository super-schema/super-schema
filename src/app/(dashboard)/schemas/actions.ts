"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function getDomainsAction() {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Not authenticated" };
  }

  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { entities: true } },
    },
  });
  return domains;
}

export async function createDomainAction(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const name = formData.get("name") as string;
  const description = (formData.get("description") as string) || "";

  if (!name || name.trim().length === 0) {
    return { error: "Domain name is required" };
  }

  if (name.length > 64) {
    return { error: "Domain name must be 64 characters or less" };
  }

  try {
    await withAudit({
      action: "CREATE",
      entityType: "Domain",
      entityId: "pending",
      userId: session.user.id,
      fn: () =>
        prisma.domain.create({
          data: { name: name.trim(), description },
        }),
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `A domain named "${name}" already exists` };
    }
    throw e;
  }
}

export async function deleteDomainAction(domainId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { _count: { select: { entities: true } } },
  });

  if (!domain) {
    return { error: "Domain not found" };
  }

  if (domain.isSystem) {
    return { error: "System domains cannot be deleted" };
  }

  if (domain._count.entities > 0) {
    return {
      error: `Cannot delete — ${domain._count.entities} entities exist in this domain. Move or delete them first.`,
    };
  }

  await withAudit({
    action: "DELETE",
    entityType: "Domain",
    entityId: domainId,
    userId: session.user.id,
    beforeState: domain as unknown as object,
    fn: async () => {
      await prisma.domain.delete({ where: { id: domainId } });
      return null;
    },
  });
  revalidatePath("/schemas");
  return { success: true };
}
