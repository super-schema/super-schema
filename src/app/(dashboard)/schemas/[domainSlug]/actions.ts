"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createEntityAction(domainId: string, formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const name = formData.get("name") as string;
  const description = (formData.get("description") as string) || "";

  if (!name || name.trim().length === 0) {
    return { error: "Entity name is required" };
  }

  if (name.length > 128) {
    return { error: "Entity name must be 128 characters or less" };
  }

  try {
    await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId: session.user.id,
      fn: async () => {
        return prisma.entity.create({
          data: {
            name: name.trim(),
            domainId,
            description,
            ownerId: session.user!.id!,
          },
        });
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `An entity named "${name}" already exists in this domain` };
    }
    throw e;
  }
}
