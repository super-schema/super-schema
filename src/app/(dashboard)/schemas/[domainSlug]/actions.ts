"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { getActiveTenantId } from "@/lib/active-tenant";
import { resolveCurrentUserId, STALE_SESSION_ENTITY_ERROR } from "@/lib/current-user";
import { mapFieldCreateInput } from "@/lib/entity-field-input";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { validateScope, type LevelScope } from "@/lib/levels";
import { assertNameAvailable, type NamedAsset, type RegistryKind } from "@/services/name-registry.service";
import { createInScope, ServiceErrorRejection } from "@/services/scoped-create.service";
import { err, ok } from "@/types/result";
import type { ServiceError } from "@/types/result";

const STALE_SESSION_IMPORT_ERROR =
  "Your session is stale. Sign out and sign in again, then retry the import.";

/**
 * `validateScope("api", …)` guarantees an API carries a domain; this narrows the
 * type for ServiceDefinition's required `domainId` column.
 */
function requireApiPlacement(scope: LevelScope) {
  if (!scope.domainId) throw new Error("An API must belong to a domain.");
  return { tenantId: scope.tenantId, domainId: scope.domainId, productId: scope.productId };
}

/**
 * An entity-scoped API always lives at its owning entity's product scope; a
 * tenant-level (Enterprise) entity cannot own one.
 */
async function resolveEntityApiTarget(
  entityId: string | undefined
): Promise<{ target: ScopeTarget } | { error: string }> {
  if (!entityId) return { error: "Select an entity for an entity-scoped API" };
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { id: true, productId: true },
  });
  if (!entity) return { error: "Entity not found" };
  if (!entity.productId) return { error: "Enterprise entities cannot own APIs" };
  return { target: { level: "PRODUCT", productId: entity.productId } };
}

const DATA_TYPE_TARGET_REQUIRED = "A domain or scope target is required";

/**
 * Data types are created at an explicit `target`; the original call shape passes
 * only a domain. Enterprise (TENANT) callers have no domain and always pass a target,
 * but the tenant is never taken from the client: a TENANT target is created under the
 * server-resolved active tenant, whatever `tenantId` the caller supplied.
 */
async function dataTypeTarget(
  domainId: string | null,
  target: ScopeTarget | undefined
): Promise<ScopeTarget | null> {
  if (target?.level === "TENANT") return { level: "TENANT", tenantId: await getActiveTenantId() };
  if (target) return target;
  return domainId ? { level: "DOMAIN", domainId } : null;
}

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

/**
 * Create an entity at product level through the shared scoped-create pattern
 * (placement matrix + line-unique name registry under the tenant lock), audited.
 * Returns `{ error }` for placement/registry rejections; other failures (stale
 * session, DB unique-index hits) propagate to the caller's catch.
 */
async function createProductEntity(params: {
  userId: string;
  domainId: string;
  productId?: string;
  name: string;
  description: string;
  fields?: CreateFieldInput[];
}): Promise<{ entityId: string } | { error: string }> {
  const { userId, domainId, description, fields } = params;
  const name = params.name.trim();

  const reservedMsg = reservedEntitySlugMessage(name);
  if (reservedMsg) {
    return { error: reservedMsg };
  }

  const productId = params.productId ?? (await ensureDefaultProductId(domainId));

  try {
    const entity = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId,
      fn: async () => {
        const created = await createInScope(prisma, {
          kind: "entity",
          target: { level: "PRODUCT", productId },
          name,
          precondition: (scope) =>
            scope.domainId === domainId
              ? ok(undefined)
              : err({ code: "INVALID_SCOPE", message: "Product does not belong to this domain" }),
          write: (tx, scope) =>
            tx.entity.create({
              data: {
                name,
                slug: generateSlug(name),
                ...scope,
                description,
                ownerId: userId,
                ...(fields && { fields: { create: fields.map(mapFieldCreateInput) } }),
              },
            }),
        });
        if (!created.success) throw new ServiceErrorRejection(created.error);
        return created.data;
      },
    });
    return { entityId: entity.id };
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return { error: e.message };
    throw e;
  }
}

export async function createEntityWithFieldsAction(
  domainId: string,
  data: { name: string; description: string; fields: CreateFieldInput[] },
  productId?: string
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
    const currentUserId = await resolveCurrentUserId(session.user);

    const created = await createProductEntity({
      userId: currentUserId,
      domainId,
      productId,
      name,
      description,
      fields,
    });
    if ("error" in created) return { error: created.error };

    revalidatePath("/schemas");
    return { success: true, entityId: created.entityId };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return { error: STALE_SESSION_ENTITY_ERROR };
    }
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
    const currentUserId = await resolveCurrentUserId(session.user);

    const created = await createProductEntity({
      userId: currentUserId,
      domainId,
      name,
      description,
    });
    if ("error" in created) return { error: created.error };

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return { error: STALE_SESSION_ENTITY_ERROR };
    }
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
    const currentUserId = await resolveCurrentUserId(session.user);

    // Verify the entity exists before attempting delete
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { id: true, name: true },
    });
    if (!entity) return { error: "Entity not found" };

    await withAudit({
      action: "DELETE",
      entityType: "Entity",
      entityId,
      userId: currentUserId,
      fn: async () => {
        await prisma.entity.delete({ where: { id: entityId } });
        return { id: entityId };
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) {
      return { error: "Your session is stale. Sign out and sign in again, then retry." };
    }
    return { error: e instanceof Error ? e.message : "Failed to delete entity" };
  }
}

// ---------------------------------------------------------------------------
// Shared Enum CRUD
// ---------------------------------------------------------------------------

export async function createSharedEnumAction(
  domainId: string | null,
  data: { name: string; values: string[]; description?: string },
  target?: ScopeTarget
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const scopeTarget = await dataTypeTarget(domainId, target);
  if (!scopeTarget) return { error: DATA_TYPE_TARGET_REQUIRED };
  try {
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget,
      name: data.name,
      write: (tx, scope) =>
        tx.sharedEnum.create({
          data: { name: data.name, values: data.values, description: data.description ?? "", ...scope },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
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
  domainId: string | null,
  data: { name: string; baseType: string; format?: string; pattern?: string; description?: string },
  target?: ScopeTarget
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const scopeTarget = await dataTypeTarget(domainId, target);
  if (!scopeTarget) return { error: DATA_TYPE_TARGET_REQUIRED };
  try {
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget,
      name: data.name,
      write: (tx, scope) =>
        tx.customScalar.create({
          data: {
            name: data.name,
            baseType: data.baseType,
            format: data.format ?? null,
            pattern: data.pattern ?? null,
            description: data.description ?? "",
            ...scope,
          },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
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
  domainId: string | null,
  data: { name: string; memberTypes: string[]; description?: string },
  target?: ScopeTarget
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const scopeTarget = await dataTypeTarget(domainId, target);
  if (!scopeTarget) return { error: DATA_TYPE_TARGET_REQUIRED };
  try {
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget,
      name: data.name,
      write: (tx, scope) =>
        tx.unionType.create({
          data: { name: data.name, memberTypes: data.memberTypes, description: data.description ?? "", ...scope },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
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
// API service / operation CRUD
// ---------------------------------------------------------------------------

export async function createServiceAction(
  domainId: string,
  data: { name: string; description?: string; basePath?: string; scope: "DOMAIN" | "ENTITY"; entityId?: string },
  target: ScopeTarget = { level: "DOMAIN", domainId }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    // An entity-scoped API lives at its entity's product scope; any passed target is ignored.
    let apiTarget = target;
    if (data.scope === "ENTITY") {
      const derived = await resolveEntityApiTarget(data.entityId);
      if ("error" in derived) return { error: derived.error };
      apiTarget = derived.target;
    }

    const name = data.name.trim();
    const result = await createInScope(prisma, {
      kind: "api",
      target: apiTarget,
      name,
      write: (tx, scope) =>
        tx.serviceDefinition.create({
          data: {
            name,
            description: data.description ?? "",
            basePath: data.basePath ?? "/",
            ...requireApiPlacement(scope),
            scope: data.scope,
            entityId: data.scope === "ENTITY" ? data.entityId : undefined,
          },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true, serviceId: result.data.id };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to create API service" };
  }
}

// Entity API tab calls this once, on the first operation it adds, so each
// entity gets a single implicit ENTITY-scoped service to hang operations off.
// The service lives at its entity's own level: product-level entities get a
// product-level API, and tenant-level (Enterprise) entities cannot own one.
export async function getOrCreateEntityServiceAction(_domainId: string, entityId: string, entityName: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    const existing = await prisma.serviceDefinition.findFirst({
      where: { entityId },
      select: { id: true },
    });
    if (existing) return { success: true, serviceId: existing.id };

    const derived = await resolveEntityApiTarget(entityId);
    if ("error" in derived) return { error: derived.error };

    const name = `${entityName}Api`;
    const result = await createInScope(prisma, {
      kind: "api",
      target: derived.target,
      name,
      write: (tx, scope) =>
        tx.serviceDefinition.create({
          data: { name, basePath: "/", ...requireApiPlacement(scope), scope: "ENTITY", entityId },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true, serviceId: result.data.id };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to create API service" };
  }
}

export async function deleteServiceAction(serviceId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.serviceDefinition.delete({ where: { id: serviceId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete API service" };
  }
}

export interface OperationParamInput {
  name: string;
  type: string;
  location: string;
  required: boolean;
  description?: string;
}

export interface OperationResponseInput {
  statusCode: number;
  type?: string | null;
  description?: string;
}

export async function createOperationAction(
  serviceId: string,
  data: {
    name: string;
    httpMethod: string;
    httpPath: string;
    description?: string;
    parameters?: OperationParamInput[];
    responses?: OperationResponseInput[];
  }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    const created = await prisma.operation.create({
      data: {
        serviceId,
        name: data.name.trim(),
        httpMethod: data.httpMethod,
        httpPath: data.httpPath,
        description: data.description ?? "",
        parameters: {
          create: (data.parameters ?? []).map((p) => ({
            name: p.name,
            type: p.type,
            location: p.location,
            required: p.required,
            description: p.description ?? "",
          })),
        },
        responses: {
          create: (data.responses ?? []).map((r) => ({
            statusCode: r.statusCode,
            type: r.type ?? null,
            description: r.description ?? "",
          })),
        },
      },
    });
    revalidatePath("/schemas");
    return { success: true, operationId: created.id };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to create operation" };
  }
}

export async function updateOperationAction(
  operationId: string,
  data: { name?: string; httpMethod?: string; httpPath?: string; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.operation.update({ where: { id: operationId }, data });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update operation" };
  }
}

// Replaces an operation's core fields and its full parameter/response list in
// one transaction — simpler than per-row param/response CRUD actions, and the
// editor always has the complete lists in hand anyway.
export async function replaceOperationDetailsAction(
  operationId: string,
  data: {
    name: string;
    httpMethod: string;
    httpPath: string;
    description?: string;
    parameters: OperationParamInput[];
    responses: OperationResponseInput[];
  }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.$transaction([
      prisma.operationParameter.deleteMany({ where: { operationId } }),
      prisma.operationResponse.deleteMany({ where: { operationId } }),
      prisma.operation.update({
        where: { id: operationId },
        data: {
          name: data.name.trim(),
          httpMethod: data.httpMethod,
          httpPath: data.httpPath,
          description: data.description ?? "",
          parameters: {
            create: data.parameters.map((p) => ({
              name: p.name,
              type: p.type,
              location: p.location,
              required: p.required,
              description: p.description ?? "",
            })),
          },
          responses: {
            create: data.responses.map((r) => ({
              statusCode: r.statusCode,
              type: r.type ?? null,
              description: r.description ?? "",
            })),
          },
        },
      }),
    ]);
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to update operation" };
  }
}

export async function deleteOperationAction(operationId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    await prisma.operation.delete({ where: { id: operationId } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : "Failed to delete operation" };
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
  productId?: string;
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

function emptyImportResult(errors: string[] = []): BulkImportResult {
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
    errors,
  };
}

// Every imported asset now costs a few registry/pre-check queries inside the transaction,
// so a large import can outlast Prisma's 5s interactive-transaction default.
const IMPORT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

const IMPORT_KIND_LABEL: Record<RegistryKind, string> = {
  entity: "Entity",
  sharedEnum: "Enum",
  customScalar: "Scalar",
  unionType: "Union",
  service: "API",
};

/**
 * How a registry NAME_CONFLICT is reported for one imported asset. Re-importing an asset
 * that already sits at the same kind and placement keeps the familiar "already exists —
 * skipped" wording; anything else (another kind, another level) is a real naming-rule
 * violation, so the registry's own message is shown.
 */
function importConflictMessage(
  kind: RegistryKind,
  name: string,
  scope: LevelScope,
  error: ServiceError
): string {
  const hit = (error.details as { conflict?: NamedAsset } | undefined)?.conflict;
  const samePlace =
    hit && hit.kind === kind && hit.domainId === scope.domainId && hit.productId === scope.productId;
  return samePlace ? `${IMPORT_KIND_LABEL[kind]} "${name}" already exists — skipped` : error.message;
}

/**
 * Bulk import into one domain, in a single transaction.
 *
 * Rule: never issue a statement that can fail on a known conflict inside the
 * interactive transaction (Postgres aborts it). So scope is resolved and validated
 * before the first create, and every known conflict is pre-checked (model/decorator
 * by name, entity by slug, registry kinds by the line-unique name registry) and
 * skipped with a message while the rest of the import continues. Any other error
 * (registry DB_ERROR, unexpected Prisma error, product mismatch) escapes the
 * transaction, which rolls back; nothing is then reported as created.
 */
export async function createDomainAssetsFromImportAction(
  payload: BulkImportPayload
): Promise<BulkImportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return emptyImportResult(["Not authenticated"]);
  }

  // Skip messages accumulated so far; kept outside the transaction so a later
  // failure can report them alongside its own error.
  const skipped: string[] = [];

  try {
    const currentUserId = await resolveCurrentUserId(session.user);

    const imported = await prisma.$transaction(async (tx) => {
      const result = emptyImportResult(skipped); // errors aliases `skipped`

      // 1. Resolve + validate every scope before the first create.
      const domainScope = await resolveScope(tx, { level: "DOMAIN", domainId: payload.domainId });
      if (!domainScope.success) throw new Error(domainScope.error.message);
      const dataTypeScope = validateScope("dataType", domainScope.data);
      if (!dataTypeScope.success) throw new Error(dataTypeScope.error.message);
      const apiScope = validateScope("api", domainScope.data);
      if (!apiScope.success) throw new Error(apiScope.error.message);
      const { tenantId } = domainScope.data;

      // Serialize name checks + writes for this tenant (spec §4.3).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

      const importProductId =
        payload.productId ?? (await ensureDefaultProductId(payload.domainId, tx));
      const productScope = await resolveScope(tx, { level: "PRODUCT", productId: importProductId });
      if (!productScope.success) throw new Error(productScope.error.message);
      if (productScope.data.domainId !== payload.domainId) {
        throw new Error("Product does not belong to this domain");
      }
      const entityScope = validateScope("entity", productScope.data);
      if (!entityScope.success) throw new Error(entityScope.error.message);

      // Registry check right before each create, so later checks also see this batch's
      // earlier rows. Returns true when the asset is free; on a conflict it records the
      // skip and returns false. A failed check (DB_ERROR) aborts the whole import.
      const isNameFree = async (kind: RegistryKind, name: string, scope: LevelScope) => {
        const free = await assertNameAvailable(tx, { name, ...scope });
        if (free.success) return true;
        if (free.error.code !== "NAME_CONFLICT") throw new Error(free.error.message);
        skipped.push(importConflictMessage(kind, name, scope, free.error));
        return false;
      };

      for (const model of sortByInheritance(payload.models)) {
        const name = model.name.trim();
        const existing = await tx.modelDefinition.findFirst({
          where: { name, domainId: payload.domainId },
          select: { id: true },
        });
        if (existing) {
          skipped.push(`Model "${model.name}" already exists — skipped`);
          continue;
        }
        const created = await tx.modelDefinition.create({
          data: {
            name,
            description: model.description ?? "",
            domainId: payload.domainId,
            sourceFormat: "typespec",
            sourceNamespace: payload.namespace ?? null,
            extendsModelName: model.extends ?? null,
            fields: {
              create: model.fields.map((field, index) => mapModelFieldCreateInput(field, index)),
            },
          },
        });
        result.modelIds.push(created.id);
        result.modelsCreated++;
      }

      for (const decorator of payload.decoratorDefinitions) {
        const existing = await tx.decoratorDefinition.findFirst({
          where: { name: decorator.name, domainId: payload.domainId },
          select: { id: true },
        });
        if (existing) {
          skipped.push(`Decorator "${decorator.name}" already exists — skipped`);
          continue;
        }
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
      }

      for (const sharedEnum of payload.sharedEnums) {
        if (!(await isNameFree("sharedEnum", sharedEnum.name, domainScope.data))) continue;
        await tx.sharedEnum.create({
          data: {
            name: sharedEnum.name,
            values: sharedEnum.values,
            description: sharedEnum.description ?? "",
            ...domainScope.data,
          },
        });
        result.enumsCreated++;
      }

      for (const scalar of payload.customScalars) {
        if (!(await isNameFree("customScalar", scalar.name, domainScope.data))) continue;
        await tx.customScalar.create({
          data: {
            name: scalar.name,
            baseType: scalar.baseType,
            format: scalar.format ?? null,
            pattern: scalar.pattern ?? null,
            description: scalar.description ?? "",
            ...domainScope.data,
          },
        });
        result.scalarsCreated++;
      }

      for (const unionType of payload.unionTypes) {
        if (!(await isNameFree("unionType", unionType.name, domainScope.data))) continue;
        await tx.unionType.create({
          data: {
            name: unionType.name,
            memberTypes: unionType.memberTypes,
            description: unionType.description ?? "",
            ...domainScope.data,
          },
        });
        result.unionsCreated++;
      }

      // Entities created in this batch, or resolved by name below, with the product
      // each one lives in (an entity-scoped API takes its entity's product scope).
      const entityRefs = new Map<string, { id: string; productId: string }>();

      for (const entity of sortByInheritance(payload.entities)) {
        const name = entity.name.trim();
        if (!(await isNameFree("entity", name, productScope.data))) continue;

        const reservedMsg = reservedEntitySlugMessage(name);
        if (reservedMsg) {
          skipped.push(reservedMsg);
          continue;
        }

        const slug = generateSlug(entity.name);
        const slugTaken = await tx.entity.findFirst({
          where: { slug, productId: importProductId },
          select: { id: true },
        });
        if (slugTaken) {
          skipped.push(`Entity "${entity.name}" already exists — skipped`);
          continue;
        }

        const parentEntityId = entity.extends ? entityRefs.get(entity.extends)?.id : undefined;
        const created = await tx.entity.create({
          data: {
            name,
            slug,
            ...productScope.data,
            description: entity.description ?? "",
            ownerId: currentUserId,
            ...(parentEntityId ? { parentEntityId } : {}),
            fields: {
              create: entity.fields.map((field, index) => mapFieldCreateInput(field, index)),
            },
          },
        });

        entityRefs.set(entity.name, { id: created.id, productId: importProductId });
        result.entityIds.push(created.id);
        result.entitiesCreated++;
      }

      // Entity-scoped services may reference an entity that already existed
      // before this import (not just one created in this same batch) — e.g.
      // an OpenAPI import registering a new operation against an entity the
      // domain already has. Resolve those by name in one query.
      const unresolvedEntityNames = [
        ...new Set(
          payload.services
            .filter((s) => s.scope === "entity" && s.entityName && !entityRefs.has(s.entityName))
            .map((s) => s.entityName as string)
        ),
      ];
      if (unresolvedEntityNames.length > 0) {
        const existingEntities = await tx.entity.findMany({
          where: { domainId: payload.domainId, name: { in: unresolvedEntityNames } },
          select: { id: true, name: true, productId: true },
        });
        for (const existing of existingEntities) {
          // Same name in several products of the domain: prefer the import's own product.
          if (!existing.productId) continue;
          if (entityRefs.has(existing.name) && existing.productId !== importProductId) continue;
          entityRefs.set(existing.name, { id: existing.id, productId: existing.productId });
        }
      }

      for (const service of payload.services) {
        const entityRef =
          service.scope === "entity" && service.entityName
            ? entityRefs.get(service.entityName)
            : undefined;
        // An entity-scoped API lives at its entity's product scope; others at the domain.
        const serviceScope: LevelScope = entityRef
          ? { ...domainScope.data, productId: entityRef.productId }
          : domainScope.data;

        if (!(await isNameFree("service", service.name, serviceScope))) continue;
        await tx.serviceDefinition.create({
          data: {
            name: service.name,
            description: service.description ?? "",
            basePath: service.basePath ?? "/",
            tenantId,
            domainId: payload.domainId,
            productId: serviceScope.productId,
            scope: entityRef ? "ENTITY" : "DOMAIN",
            entityId: entityRef?.id,
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
      }

      return result;
    }, IMPORT_TRANSACTION_OPTIONS);

    revalidatePath("/schemas");
    return imported;
  } catch (e: unknown) {
    // The transaction rolled back (or never started): nothing from this import exists,
    // so report zero counts with every skip message so far plus the real cause.
    const message =
      e instanceof AuditUserMissingError
        ? STALE_SESSION_IMPORT_ERROR
        : e instanceof Error
          ? e.message
          : "Bulk import failed";
    return emptyImportResult([...skipped, message]);
  }
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
