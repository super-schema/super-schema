"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function addFieldAction(entityId: string, name: string, type: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const maxField = await prisma.field.findFirst({
    where: { entityId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  try {
    const field = await withAudit({
      action: "CREATE",
      entityType: "Field",
      entityId: "pending",
      userId: session.user.id,
      fn: () =>
        prisma.field.create({
          data: {
            entityId,
            name,
            type,
            sortOrder: maxField ? maxField.sortOrder + 1 : 0,
          },
        }),
    });
    revalidatePath("/schemas");
    return { success: true, field };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `Field "${name}" already exists` };
    }
    throw e;
  }
}

export async function updateFieldAction(
  fieldId: string,
  data: { name?: string; type?: string; nullable?: boolean; isKey?: boolean }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing) return { error: "Field not found" };

  await withAudit({
    action: "UPDATE",
    entityType: "Field",
    entityId: fieldId,
    userId: session.user.id,
    beforeState: existing as unknown as object,
    fn: () => prisma.field.update({ where: { id: fieldId }, data }),
  });

  revalidatePath("/schemas");
  return { success: true };
}

export async function deleteFieldAction(fieldId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing) return { error: "Field not found" };

  await withAudit({
    action: "DELETE",
    entityType: "Field",
    entityId: fieldId,
    userId: session.user.id,
    beforeState: existing as unknown as object,
    fn: async () => {
      await prisma.field.delete({ where: { id: fieldId } });
      return null;
    },
  });

  revalidatePath("/schemas");
  return { success: true };
}
