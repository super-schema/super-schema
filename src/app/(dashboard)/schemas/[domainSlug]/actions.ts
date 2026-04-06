"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug } from "@/lib/slug";

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
            slug: generateSlug(name),
            domainId,
            description,
            ownerId: session.user!.id!,
            fields: {
              create: fields.map((f, i) => ({
                name: f.name,
                slug: generateSlug(f.name),
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
            slug: generateSlug(name),
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

// ---------------------------------------------------------------------------
// Bulk import: create multiple entities + shared types in one transaction
// ---------------------------------------------------------------------------

export interface BulkImportPayload {
  domainId: string;
  entities: Array<{
    name: string;
    description?: string;
    extends?: string;
    fields: CreateFieldInput[];
  }>;
  sharedEnums: Array<{ name: string; values: string[]; description?: string }>;
  customScalars: Array<{ name: string; baseType: string; description?: string }>;
  unionTypes: Array<{ name: string; memberTypes: string[]; description?: string }>;
}

export interface BulkImportResult {
  entitiesCreated: number;
  enumsCreated: number;
  scalarsCreated: number;
  unionsCreated: number;
  entityIds: string[];
  errors: string[];
}

function sortByInheritance(
  entities: BulkImportPayload["entities"]
): BulkImportPayload["entities"] {
  const nameSet = new Set(entities.map((e) => e.name));
  const sorted: BulkImportPayload["entities"] = [];
  const added = new Set<string>();
  const remaining = [...entities];

  let maxPasses = entities.length + 1;
  while (remaining.length > 0 && maxPasses-- > 0) {
    const nextRemaining: typeof remaining = [];
    for (const entity of remaining) {
      const parent = entity.extends;
      if (!parent || !nameSet.has(parent) || added.has(parent)) {
        sorted.push(entity);
        added.add(entity.name);
      } else {
        nextRemaining.push(entity);
      }
    }
    if (nextRemaining.length === remaining.length) {
      sorted.push(...nextRemaining);
      break;
    }
    remaining.length = 0;
    remaining.push(...nextRemaining);
  }

  return sorted;
}

export async function createEntitiesFromImportAction(
  payload: BulkImportPayload
): Promise<BulkImportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { entitiesCreated: 0, enumsCreated: 0, scalarsCreated: 0, unionsCreated: 0, entityIds: [], errors: ["Not authenticated"] };
  }

  const result: BulkImportResult = {
    entitiesCreated: 0, enumsCreated: 0, scalarsCreated: 0, unionsCreated: 0, entityIds: [], errors: [],
  };

  try {
    await prisma.$transaction(async (tx) => {
      for (const e of payload.sharedEnums) {
        try {
          await tx.sharedEnum.create({
            data: { name: e.name, values: e.values, description: e.description ?? "", domainId: payload.domainId },
          });
          result.enumsCreated++;
        } catch (err: unknown) {
          result.errors.push(err instanceof Error && err.message.includes("Unique constraint")
            ? `Enum "${e.name}" already exists — skipped` : `Failed to create enum "${e.name}"`);
        }
      }

      for (const s of payload.customScalars) {
        try {
          await tx.customScalar.create({
            data: { name: s.name, baseType: s.baseType, description: s.description ?? "", domainId: payload.domainId },
          });
          result.scalarsCreated++;
        } catch (err: unknown) {
          result.errors.push(err instanceof Error && err.message.includes("Unique constraint")
            ? `Scalar "${s.name}" already exists — skipped` : `Failed to create scalar "${s.name}"`);
        }
      }

      for (const u of payload.unionTypes) {
        try {
          await tx.unionType.create({
            data: { name: u.name, memberTypes: u.memberTypes, description: u.description ?? "", domainId: payload.domainId },
          });
          result.unionsCreated++;
        } catch (err: unknown) {
          result.errors.push(err instanceof Error && err.message.includes("Unique constraint")
            ? `Union "${u.name}" already exists — skipped` : `Failed to create union "${u.name}"`);
        }
      }

      const sortedEntities = sortByInheritance(payload.entities);
      const createdEntityMap = new Map<string, string>();

      for (const entity of sortedEntities) {
        try {
          let parentEntityId: string | undefined;
          if (entity.extends && createdEntityMap.has(entity.extends)) {
            parentEntityId = createdEntityMap.get(entity.extends);
          }

          const created = await tx.entity.create({
            data: {
              name: entity.name.trim(),
              slug: generateSlug(entity.name),
              domainId: payload.domainId,
              description: entity.description ?? "",
              ownerId: session.user!.id!,
              ...(parentEntityId && { parentEntityId }),
              fields: {
                create: entity.fields.map((f, i) => ({
                  name: f.name, slug: generateSlug(f.name), type: f.type,
                  nullable: f.nullable, isKey: f.isKey, description: f.description,
                  classification: f.classification, precision: f.precision, scale: f.scale,
                  sortOrder: i,
                  ...(f.aliases?.length && { aliases: f.aliases }),
                  ...(f.decorators && Object.keys(f.decorators).length > 0 && { decorators: f.decorators as Prisma.InputJsonValue }),
                })),
              },
            },
          });

          createdEntityMap.set(entity.name, created.id);
          result.entityIds.push(created.id);
          result.entitiesCreated++;
        } catch (err: unknown) {
          result.errors.push(err instanceof Error && err.message.includes("Unique constraint")
            ? `Entity "${entity.name}" already exists — skipped` : `Failed to create entity "${entity.name}"`);
        }
      }
    });

    revalidatePath("/schemas");
  } catch (e: unknown) {
    result.errors.push(e instanceof Error ? e.message : "Bulk import failed");
  }

  return result;
}
