"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug } from "@/lib/slug";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { validateScope, type LevelScope } from "@/lib/levels";
import { assertNameAvailable, withTenantNameLock } from "@/services/name-registry.service";
import { ok } from "@/types/result";

const STALE_SESSION_IMPORT_ERROR =
  "Your session is stale. Sign out and sign in again, then retry the import.";
const STALE_SESSION_ENTITY_ERROR =
  "Your session is stale. Sign out and sign in again, then create the entity.";

/**
 * The name registry rejected an asset (conflict or failed check). Thrown from inside an
 * audited or transactional create so the surrounding work rolls back / is never audited.
 */
class NameConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameConflictError";
  }
}

/**
 * `validateScope("api", …)` guarantees an API carries a domain; this narrows the
 * type for ServiceDefinition's required `domainId` column.
 */
function apiPlacement(scope: LevelScope) {
  return scope.domainId
    ? { tenantId: scope.tenantId, domainId: scope.domainId, productId: scope.productId }
    : null;
}

async function resolveCurrentUserId(user: { id?: string | null; email?: string | null }) {
  if (!user.id) {
    throw new AuditUserMissingError("unknown");
  }

  const userById = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true },
  });

  if (userById) {
    return userById.id;
  }

  if (user.email) {
    const userByEmail = await prisma.user.findUnique({
      where: { email: user.email },
      select: { id: true },
    });

    if (userByEmail) {
      return userByEmail.id;
    }
  }

  throw new AuditUserMissingError(user.id);
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
 * Create an entity at product level: validates the placement matrix, then checks the
 * line-unique name registry and writes under the tenant's advisory lock. Returns an
 * `{ error }` for placement/registry rejections; other failures (stale session, DB
 * unique-index hits) propagate to the caller's catch.
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

  const productId = params.productId ?? (await ensureDefaultProductId(domainId));
  const scope = await resolveScope(prisma, { level: "PRODUCT", productId });
  if (!scope.success) return { error: scope.error.message };
  if (scope.data.domainId !== domainId) return { error: "Product does not belong to this domain" };
  const valid = validateScope("entity", scope.data);
  if (!valid.success) return { error: valid.error.message };

  try {
    const entity = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId,
      fn: async () => {
        const outcome = await withTenantNameLock(prisma, scope.data.tenantId, async (tx) => {
          const free = await assertNameAvailable(tx, { name, ...scope.data });
          if (!free.success) return free;
          return ok(
            await tx.entity.create({
              data: {
                name,
                slug: generateSlug(name),
                ...scope.data,
                description,
                ownerId: userId,
                ...(fields && { fields: { create: fields.map(mapFieldCreateInput) } }),
              },
            })
          );
        });
        if (!outcome.success) throw new NameConflictError(outcome.error.message);
        return outcome.data;
      },
    });
    return { entityId: entity.id };
  } catch (e: unknown) {
    if (e instanceof NameConflictError) return { error: e.message };
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
  domainId: string,
  data: { name: string; values: string[]; description?: string },
  target: ScopeTarget = { level: "DOMAIN", domainId }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    const scope = await resolveScope(prisma, target);
    if (!scope.success) return { error: scope.error.message };
    const valid = validateScope("dataType", scope.data);
    if (!valid.success) return { error: valid.error.message };

    const result = await withTenantNameLock(prisma, scope.data.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name: data.name, ...scope.data });
      if (!free.success) return free;
      await tx.sharedEnum.create({
        data: { name: data.name, values: data.values, description: data.description ?? "", ...scope.data },
      });
      return ok(undefined);
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
  domainId: string,
  data: { name: string; baseType: string; format?: string; pattern?: string; description?: string },
  target: ScopeTarget = { level: "DOMAIN", domainId }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    const scope = await resolveScope(prisma, target);
    if (!scope.success) return { error: scope.error.message };
    const valid = validateScope("dataType", scope.data);
    if (!valid.success) return { error: valid.error.message };

    const result = await withTenantNameLock(prisma, scope.data.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name: data.name, ...scope.data });
      if (!free.success) return free;
      await tx.customScalar.create({
        data: {
          name: data.name,
          baseType: data.baseType,
          format: data.format ?? null,
          pattern: data.pattern ?? null,
          description: data.description ?? "",
          ...scope.data,
        },
      });
      return ok(undefined);
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
  domainId: string,
  data: { name: string; memberTypes: string[]; description?: string },
  target: ScopeTarget = { level: "DOMAIN", domainId }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  try {
    const scope = await resolveScope(prisma, target);
    if (!scope.success) return { error: scope.error.message };
    const valid = validateScope("dataType", scope.data);
    if (!valid.success) return { error: valid.error.message };

    const result = await withTenantNameLock(prisma, scope.data.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name: data.name, ...scope.data });
      if (!free.success) return free;
      await tx.unionType.create({
        data: { name: data.name, memberTypes: data.memberTypes, description: data.description ?? "", ...scope.data },
      });
      return ok(undefined);
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
    const scope = await resolveScope(prisma, target);
    if (!scope.success) return { error: scope.error.message };
    const valid = validateScope("api", scope.data);
    if (!valid.success) return { error: valid.error.message };
    const placement = apiPlacement(scope.data);
    if (!placement) return { error: "An API must belong to a domain." };

    const name = data.name.trim();
    const result = await withTenantNameLock(prisma, placement.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name, ...placement });
      if (!free.success) return free;
      const created = await tx.serviceDefinition.create({
        data: {
          name,
          description: data.description ?? "",
          basePath: data.basePath ?? "/",
          ...placement,
          scope: data.scope,
          entityId: data.scope === "ENTITY" ? data.entityId : undefined,
        },
      });
      return ok(created);
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

    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { id: true, productId: true },
    });
    if (!entity) return { error: "Entity not found" };
    if (!entity.productId) return { error: "Enterprise entities cannot own APIs" };

    const scope = await resolveScope(prisma, { level: "PRODUCT", productId: entity.productId });
    if (!scope.success) return { error: scope.error.message };
    const valid = validateScope("api", scope.data);
    if (!valid.success) return { error: valid.error.message };
    const placement = apiPlacement(scope.data);
    if (!placement) return { error: "An API must belong to a domain." };

    const name = `${entityName}Api`;
    const result = await withTenantNameLock(prisma, placement.tenantId, async (tx) => {
      const free = await assertNameAvailable(tx, { name, ...placement });
      if (!free.success) return free;
      const created = await tx.serviceDefinition.create({
        data: { name, basePath: "/", ...placement, scope: "ENTITY", entityId },
      });
      return ok(created);
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

export async function createDomainAssetsFromImportAction(
  payload: BulkImportPayload
): Promise<BulkImportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return emptyImportResult(["Not authenticated"]);
  }

  const result = emptyImportResult();

  try {
    const currentUserId = await resolveCurrentUserId(session.user);

    await prisma.$transaction(async (tx) => {
      const domainScope = await resolveScope(tx, { level: "DOMAIN", domainId: payload.domainId });
      if (!domainScope.success) throw new Error(domainScope.error.message);
      const { tenantId } = domainScope.data;

      // Serialize name checks + writes for this tenant (spec §4.3). Each asset is
      // checked right before its create, so later checks also see this batch's
      // earlier rows — two same-named assets in one import conflict with each other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;
      const assertNameFree = async (name: string, scope: LevelScope) => {
        const free = await assertNameAvailable(tx, { name, ...scope });
        if (!free.success) throw new NameConflictError(free.error.message);
      };

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
        await assertNameFree(sharedEnum.name, domainScope.data);
        try {
          await tx.sharedEnum.create({
            data: {
              name: sharedEnum.name,
              values: sharedEnum.values,
              description: sharedEnum.description ?? "",
              ...domainScope.data,
            },
          });
          result.enumsCreated++;
        } catch {
          result.errors.push(`Failed to create enum "${sharedEnum.name}"`);
        }
      }

      for (const scalar of payload.customScalars) {
        await assertNameFree(scalar.name, domainScope.data);
        try {
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
        } catch {
          result.errors.push(`Failed to create scalar "${scalar.name}"`);
        }
      }

      for (const unionType of payload.unionTypes) {
        await assertNameFree(unionType.name, domainScope.data);
        try {
          await tx.unionType.create({
            data: {
              name: unionType.name,
              memberTypes: unionType.memberTypes,
              description: unionType.description ?? "",
              ...domainScope.data,
            },
          });
          result.unionsCreated++;
        } catch {
          result.errors.push(`Failed to create union "${unionType.name}"`);
        }
      }

      const sortedEntities = sortByInheritance(payload.entities);
      const createdEntityMap = new Map<string, string>();
      const importProductId =
        payload.productId ?? (await ensureDefaultProductId(payload.domainId, tx));
      const productScope = await resolveScope(tx, { level: "PRODUCT", productId: importProductId });
      if (!productScope.success) throw new Error(productScope.error.message);
      if (productScope.data.domainId !== payload.domainId) {
        throw new Error("Product does not belong to this domain");
      }

      for (const entity of sortedEntities) {
        await assertNameFree(entity.name.trim(), productScope.data);
        try {
          const parentEntityId =
            entity.extends && createdEntityMap.has(entity.extends)
              ? createdEntityMap.get(entity.extends)
              : undefined;

          const created = await tx.entity.create({
            data: {
              name: entity.name.trim(),
              slug: generateSlug(entity.name),
              ...productScope.data,
              description: entity.description ?? "",
              ownerId: currentUserId,
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

      // Entity-scoped services may reference an entity that already existed
      // before this import (not just one created in this same batch) — e.g.
      // an OpenAPI import registering a new operation against an entity the
      // domain already has. Resolve those by name in one query.
      const unresolvedEntityNames = [
        ...new Set(
          payload.services
            .filter((s) => s.scope === "entity" && s.entityName && !createdEntityMap.has(s.entityName))
            .map((s) => s.entityName as string)
        ),
      ];
      if (unresolvedEntityNames.length > 0) {
        const existingEntities = await tx.entity.findMany({
          where: { domainId: payload.domainId, name: { in: unresolvedEntityNames } },
          select: { id: true, name: true },
        });
        for (const existing of existingEntities) {
          createdEntityMap.set(existing.name, existing.id);
        }
      }

      for (const service of payload.services) {
        await assertNameFree(service.name, domainScope.data);
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
              tenantId,
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
        } catch {
          result.errors.push(`Failed to create API "${service.name}"`);
        }
      }
    });

    revalidatePath("/schemas");
  } catch (e: unknown) {
    // The transaction rolled back, so nothing from this import was created.
    if (e instanceof NameConflictError) return emptyImportResult([e.message]);
    result.errors.push(
      e instanceof AuditUserMissingError
        ? STALE_SESSION_IMPORT_ERROR
        : e instanceof Error
          ? e.message
          : "Bulk import failed"
    );
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
