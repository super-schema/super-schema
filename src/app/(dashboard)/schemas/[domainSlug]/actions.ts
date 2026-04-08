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
// Model field CRUD
// ---------------------------------------------------------------------------

export async function addModelFieldAction(
  modelId: string,
  data: { name: string; type: string; nullable?: boolean; isKey?: boolean; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const model = await prisma.modelDefinition.findUnique({ where: { id: modelId }, include: { fields: true } });
    if (!model) return { error: "Model not found" };

    await prisma.modelFieldDefinition.create({
      data: {
        modelId,
        name: data.name,
        type: data.type,
        nullable: data.nullable ?? true,
        isKey: data.isKey ?? false,
        description: data.description ?? "",
        sortOrder: model.fields.length,
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `Field "${data.name}" already exists` };
    }
    return { error: e instanceof Error ? e.message : "Failed to add field" };
  }
}

export async function updateModelFieldAction(
  fieldId: string,
  data: { name?: string; type?: string; nullable?: boolean; isKey?: boolean; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.modelFieldDefinition.update({ where: { id: fieldId }, data });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update field" };
  }
}

export async function deleteModelFieldAction(fieldId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.modelFieldDefinition.delete({ where: { id: fieldId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete field" };
  }
}

// ---------------------------------------------------------------------------
// Entity delete
// ---------------------------------------------------------------------------

export async function deleteEntityAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.entity.delete({ where: { id: entityId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete entity" };
  }
}

// ---------------------------------------------------------------------------
// Shared Enum CRUD
// ---------------------------------------------------------------------------

export async function createSharedEnumAction(
  domainId: string,
  data: { name: string; values: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.sharedEnum.create({
      data: { name: data.name, values: data.values, description: data.description ?? "", domainId },
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) return { error: `Enum "${data.name}" already exists` };
    return { error: e instanceof Error ? e.message : "Failed to create enum" };
  }
}

export async function deleteSharedEnumAction(enumId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.sharedEnum.delete({ where: { id: enumId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete enum" };
  }
}

export async function updateSharedEnumAction(
  enumId: string,
  data: { values?: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.sharedEnum.update({ where: { id: enumId }, data });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update enum" };
  }
}

// ---------------------------------------------------------------------------
// Custom Scalar CRUD
// ---------------------------------------------------------------------------

export async function createCustomScalarAction(
  domainId: string,
  data: { name: string; baseType: string; format?: string; pattern?: string; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.customScalar.create({
      data: { name: data.name, baseType: data.baseType, format: data.format ?? null, pattern: data.pattern ?? null, description: data.description ?? "", domainId },
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) return { error: `Scalar "${data.name}" already exists` };
    return { error: e instanceof Error ? e.message : "Failed to create scalar" };
  }
}

export async function deleteCustomScalarAction(scalarId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.customScalar.delete({ where: { id: scalarId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete scalar" };
  }
}

export async function updateCustomScalarAction(
  scalarId: string,
  data: { baseType?: string; format?: string | null; pattern?: string | null; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.customScalar.update({ where: { id: scalarId }, data });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update scalar" };
  }
}

// ---------------------------------------------------------------------------
// Union Type CRUD
// ---------------------------------------------------------------------------

export async function createUnionTypeAction(
  domainId: string,
  data: { name: string; memberTypes: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.unionType.create({
      data: { name: data.name, memberTypes: data.memberTypes, description: data.description ?? "", domainId },
    });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) return { error: `Union "${data.name}" already exists` };
    return { error: e instanceof Error ? e.message : "Failed to create union" };
  }
}

export async function deleteUnionTypeAction(unionId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.unionType.delete({ where: { id: unionId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete union" };
  }
}

export async function updateUnionTypeAction(
  unionId: string,
  data: { memberTypes?: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.unionType.update({ where: { id: unionId }, data });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update union type" };
  }
}

// ---------------------------------------------------------------------------
// Bulk import: create models, entities, shared types, decorators, and services
// ---------------------------------------------------------------------------

export interface ImportedOperationPayload {
  name: string;
  httpMethod?: string;
  httpPath?: string;
  description?: string;
  returnType?: string;
  params: Array<{
    name: string;
    type: string;
    location?: string;
    isOptional: boolean;
  }>;
}

export interface ImportedServicePayload {
  name: string;
  description?: string;
  basePath?: string;
  scope?: "domain" | "entity";
  entityName?: string;
  operations: ImportedOperationPayload[];
}

export interface ImportedDecoratorDefinitionPayload {
  name: string;
  description?: string;
  signature: string;
  targetTypes: string[];
}

export interface BulkImportPayload {
  domainId: string;
  namespace?: string;
  models: Array<{
    name: string;
    description?: string;
    extends?: string;
    fields: CreateFieldInput[];
  }>;
  entities: Array<{
    name: string;
    description?: string;
    extends?: string;
    fields: CreateFieldInput[];
  }>;
  sharedEnums: Array<{ name: string; values: string[]; description?: string }>;
  customScalars: Array<{
    name: string;
    baseType: string;
    format?: string;
    pattern?: string;
    description?: string;
  }>;
  unionTypes: Array<{ name: string; memberTypes: string[]; description?: string }>;
  services: ImportedServicePayload[];
  decoratorDefinitions: ImportedDecoratorDefinitionPayload[];
}

export interface BulkImportResult {
  modelsCreated: number;
  entitiesCreated: number;
  enumsCreated: number;
  scalarsCreated: number;
  unionsCreated: number;
  servicesCreated: number;
  decoratorsCreated: number;
  entityIds: string[];
  modelIds: string[];
  errors: string[];
}

function sortByInheritance<T extends { name: string; extends?: string }>(items: T[]): T[] {
  const nameSet = new Set(items.map((item) => item.name));
  const sorted: T[] = [];
  const added = new Set<string>();
  const remaining = [...items];

  let maxPasses = items.length + 1;
  while (remaining.length > 0 && maxPasses-- > 0) {
    const nextRemaining: typeof remaining = [];
    for (const item of remaining) {
      const parent = item.extends;
      if (!parent || !nameSet.has(parent) || added.has(parent)) {
        sorted.push(item);
        added.add(item.name);
      } else {
        nextRemaining.push(item);
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

function mapFieldCreateInput(
  field: CreateFieldInput,
  index: number
): Prisma.FieldCreateWithoutEntityInput {
  return {
    name: field.name,
    slug: generateSlug(field.name),
    type: field.type,
    nullable: field.nullable,
    isKey: field.isKey,
    description: field.description,
    classification: field.classification,
    precision: field.precision,
    scale: field.scale,
    sortOrder: index,
    ...(field.aliases?.length ? { aliases: field.aliases } : {}),
    ...(field.decorators && Object.keys(field.decorators).length > 0
      ? { decorators: field.decorators as Prisma.InputJsonValue }
      : {}),
  };
}

function mapModelFieldCreateInput(
  field: CreateFieldInput,
  index: number
): Prisma.ModelFieldDefinitionCreateWithoutModelInput {
  return {
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    isKey: field.isKey,
    description: field.description,
    classification: field.classification,
    precision: field.precision,
    scale: field.scale,
    sortOrder: index,
    ...(field.aliases?.length ? { aliases: field.aliases } : {}),
    ...(field.decorators && Object.keys(field.decorators).length > 0
      ? { decorators: field.decorators as Prisma.InputJsonValue }
      : {}),
  };
}

function inferResponseFromReturnType(
  returnType: string | undefined
): Prisma.OperationResponseCreateWithoutOperationInput {
  const normalized = returnType?.trim();
  if (!normalized || normalized === "void" || normalized === "never") {
    return {
      statusCode: 204,
      type: null,
      description: "Imported from TypeSpec operation without a response body.",
    };
  }

  return {
    statusCode: 200,
    type: normalized,
    description: "Imported from TypeSpec operation return type.",
  };
}

export async function createDomainAssetsFromImportAction(
  payload: BulkImportPayload
): Promise<BulkImportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      modelsCreated: 0,
      entitiesCreated: 0,
      enumsCreated: 0,
      scalarsCreated: 0,
      unionsCreated: 0,
      servicesCreated: 0,
      decoratorsCreated: 0,
      entityIds: [],
      modelIds: [],
      errors: ["Not authenticated"],
    };
  }

  const result: BulkImportResult = {
    modelsCreated: 0,
    entitiesCreated: 0,
    enumsCreated: 0,
    scalarsCreated: 0,
    unionsCreated: 0,
    servicesCreated: 0,
    decoratorsCreated: 0,
    entityIds: [],
    modelIds: [],
    errors: [],
  };

  try {
    await prisma.$transaction(async (tx) => {
      const sortedModels = sortByInheritance(payload.models);

      for (const model of sortedModels) {
        try {
          const created = await tx.modelDefinition.create({
            data: {
              name: model.name.trim(),
              description: model.description ?? "",
              domainId: payload.domainId,
              sourceFormat: "typespec",
              sourceNamespace: payload.namespace ?? null,
              extendsModelName: model.extends ?? null,
              fields: {
                create: model.fields.map((field, index) =>
                  mapModelFieldCreateInput(field, index)
                ),
              },
            },
          });
          result.modelIds.push(created.id);
          result.modelsCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Model "${model.name}" already exists — skipped`
              : `Failed to create model "${model.name}"`
          );
        }
      }

      for (const decorator of payload.decoratorDefinitions) {
        try {
          await tx.decoratorDefinition.create({
            data: {
              name: decorator.name,
              description: decorator.description ?? "",
              signature: decorator.signature,
              targetTypes: decorator.targetTypes,
              domainId: payload.domainId,
            },
          });
          result.decoratorsCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Decorator "${decorator.name}" already exists — skipped`
              : `Failed to create decorator "${decorator.name}"`
          );
        }
      }

      for (const sharedEnum of payload.sharedEnums) {
        try {
          await tx.sharedEnum.create({
            data: {
              name: sharedEnum.name,
              values: sharedEnum.values,
              description: sharedEnum.description ?? "",
              domainId: payload.domainId,
            },
          });
          result.enumsCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Enum "${sharedEnum.name}" already exists — skipped`
              : `Failed to create enum "${sharedEnum.name}"`
          );
        }
      }

      for (const scalar of payload.customScalars) {
        try {
          await tx.customScalar.create({
            data: {
              name: scalar.name,
              baseType: scalar.baseType,
              format: scalar.format ?? null,
              pattern: scalar.pattern ?? null,
              description: scalar.description ?? "",
              domainId: payload.domainId,
            },
          });
          result.scalarsCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Scalar "${scalar.name}" already exists — skipped`
              : `Failed to create scalar "${scalar.name}"`
          );
        }
      }

      for (const unionType of payload.unionTypes) {
        try {
          await tx.unionType.create({
            data: {
              name: unionType.name,
              memberTypes: unionType.memberTypes,
              description: unionType.description ?? "",
              domainId: payload.domainId,
            },
          });
          result.unionsCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Union "${unionType.name}" already exists — skipped`
              : `Failed to create union "${unionType.name}"`
          );
        }
      }

      // Merge models into entities — all models are treated as entities
      const allEntities = [...payload.entities, ...payload.models];
      const sortedEntities = sortByInheritance(allEntities);
      const createdEntityMap = new Map<string, string>();

      for (const entity of sortedEntities) {
        try {
          const parentEntityId =
            entity.extends && createdEntityMap.has(entity.extends)
              ? createdEntityMap.get(entity.extends)
              : undefined;

          const created = await tx.entity.create({
            data: {
              name: entity.name.trim(),
              slug: generateSlug(entity.name),
              domainId: payload.domainId,
              description: entity.description ?? "",
              ownerId: session.user!.id!,
              ...(parentEntityId ? { parentEntityId } : {}),
              fields: {
                create: entity.fields.map((field, index) =>
                  mapFieldCreateInput(field, index)
                ),
              },
            },
          });

          createdEntityMap.set(entity.name, created.id);
          result.entityIds.push(created.id);
          result.entitiesCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `Entity "${entity.name}" already exists — skipped`
              : `Failed to create entity "${entity.name}"`
          );
        }
      }

      for (const service of payload.services) {
        try {
          const entityId =
            service.scope === "entity" && service.entityName
              ? createdEntityMap.get(service.entityName)
              : undefined;

          await tx.serviceDefinition.create({
            data: {
              name: service.name,
              description: service.description ?? "",
              basePath: service.basePath ?? "/",
              domainId: payload.domainId,
              scope: service.scope === "entity" && entityId ? "ENTITY" : "DOMAIN",
              entityId,
              operations: {
                create: service.operations.map((operation) => ({
                  name: operation.name,
                  httpMethod: operation.httpMethod ?? "GET",
                  httpPath: operation.httpPath ?? "/",
                  description: operation.description ?? "",
                  parameters: {
                    create: operation.params.map((param) => ({
                      name: param.name,
                      type: param.type,
                      location: param.location ?? "query",
                      required: !param.isOptional,
                      description: "",
                    })),
                  },
                  responses: {
                    create: [inferResponseFromReturnType(operation.returnType)],
                  },
                })),
              },
            },
          });
          result.servicesCreated++;
        } catch (err: unknown) {
          result.errors.push(
            err instanceof Error && err.message.includes("Unique constraint")
              ? `API "${service.name}" already exists — skipped`
              : `Failed to create API "${service.name}"`
          );
        }
      }
    });

    revalidatePath("/schemas");
  } catch (e: unknown) {
    result.errors.push(e instanceof Error ? e.message : "Bulk import failed");
  }

  return result;
}

export async function createEntitiesFromImportAction(
  payload: Omit<
    BulkImportPayload,
    "models" | "services" | "decoratorDefinitions" | "namespace"
  > & {
    models?: BulkImportPayload["models"];
    services?: BulkImportPayload["services"];
    decoratorDefinitions?: BulkImportPayload["decoratorDefinitions"];
    namespace?: string;
  }
): Promise<BulkImportResult> {
  return createDomainAssetsFromImportAction({
    namespace: payload.namespace,
    models: payload.models ?? [],
    services: payload.services ?? [],
    decoratorDefinitions: payload.decoratorDefinitions ?? [],
    ...payload,
  });
}
