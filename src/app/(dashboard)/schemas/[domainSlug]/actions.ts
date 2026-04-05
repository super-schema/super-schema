"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export interface CreateFieldInput {
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  description: string;
  classification: string | null;
  precision: number | null;
  scale: number | null;
  aliases?: string[];
  decorators?: Record<string, unknown>;
}

export async function createEntityWithFieldsAction(
  domainId: string,
  data: { name: string; description: string; fields: CreateFieldInput[] }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const { name, description, fields } = data;

  if (!name || name.trim().length === 0) {
    return { error: "Entity name is required" };
  }

  if (name.length > 128) {
    return { error: "Entity name must be 128 characters or less" };
  }

  try {
    const entity = await withAudit({
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
            fields: {
              create: fields.map((f, i) => ({
                name: f.name,
                type: f.type,
                nullable: f.nullable,
                isKey: f.isKey,
                description: f.description,
                classification: f.classification,
                precision: f.precision,
                scale: f.scale,
                sortOrder: i,
                ...(f.aliases && f.aliases.length > 0 && { aliases: f.aliases }),
                ...(f.decorators && Object.keys(f.decorators).length > 0 && { decorators: f.decorators as Prisma.InputJsonValue }),
              })),
            },
          },
        });
      },
    });

    revalidatePath("/schemas");
    return { success: true, entityId: entity.id };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `An entity named "${name}" already exists in this domain` };
    }
    const message = e instanceof Error ? e.message : "Failed to create entity";
    return { error: message };
  }
}

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
    const message = e instanceof Error ? e.message : "Failed to create entity";
    return { error: message };
  }
}
