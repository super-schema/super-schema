"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { getActiveTenantId } from "@/lib/active-tenant";
import { inActiveTenant, isInActiveTenant, notFoundFailure, targetInActiveTenant, unexpectedFailure } from "@/lib/action-context";
import {
  isBoolean, isInt, isPlainObject, isString, isStringArray, isStringOrNull, optional, pickEditable, readFields,
} from "@/lib/editable-fields";
import { parseScopeTarget, requireId } from "@/services/events/service-guards";
import { resolveCurrentUserId, STALE_SESSION_ENTITY_ERROR } from "@/lib/current-user";
import { entityDeleteFailure, explainEntityDeleteFailure } from "@/services/events/entity-pin-usage";
import { mapFieldCreateInput } from "@/lib/entity-field-input";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import { validateScope, type LevelScope } from "@/lib/levels";
import { assertNameAvailable, type NamedAsset, type RegistryKind } from "@/services/name-registry.service";
import { createInScope, ServiceErrorRejection } from "@/services/scoped-create.service";
import { isOpaqueErrorCode } from "@/types/action-result";
import { err, ok } from "@/types/result";
import type { Result, ServiceError } from "@/types/result";

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
  entityId: unknown
): Promise<{ target: ScopeTarget } | { error: string }> {
  if (typeof entityId !== "string" || !entityId) return { error: "Select an entity for an entity-scoped API" };
  // An entity of another tenant reads exactly like a missing one (same answer, nothing derived from it).
  if (!(await inActiveTenant("entity", entityId))) return { error: "Entity not found" };
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
 *
 * Both arguments arrive from the browser untyped: a target that is not a well-formed scope target (unknown level, missing /
 * non-string id) or a `domainId` that is neither null nor a string is a VALIDATION_ERROR here, before any query, instead of
 * a Prisma validation message further down.
 */
async function dataTypeTarget(domainId: unknown, target: unknown): Promise<Result<ScopeTarget>> {
  if (target !== undefined && target !== null) {
    if (isPlainObject(target) && (target as { level?: unknown }).level === "TENANT") {
      return ok({ level: "TENANT", tenantId: await getActiveTenantId() });
    }
    return parseScopeTarget(target);
  }
  if (domainId === null || domainId === undefined || domainId === "") {
    return err({ code: "VALIDATION_ERROR", message: DATA_TYPE_TARGET_REQUIRED });
  }
  const id = requireId(domainId, "domainId");
  return id.success ? ok({ level: "DOMAIN", domainId: id.data }) : id;
}

/**
 * A create's target (data type, API, bulk import) carries a domain / product id from the client: it must lie in the active tenant. Null when it does;
 * otherwise the very `{ error }` a missing target gets (`resolveScope`'s NOT_FOUND text), so a foreign one reveals nothing.
 */
async function foreignTarget(target: ScopeTarget): Promise<{ error: string } | null> {
  const owned = await targetInActiveTenant(target);
  return owned.success ? null : { error: owned.error.message };
}

/** The wire shape of the older (non-Result) actions: `{ error }` plus the failure code where there is one. */
const failure = (error: ServiceError) => ({ error: error.message, code: error.code });

/** A required, non-blank name, trimmed: the name registry compares trimmed names, so the stored name must be trimmed too. */
function trimmedName(value: unknown, label: string): Result<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return err({ code: "VALIDATION_ERROR", message: `${label} name is required` });
  }
  return ok(value.trim());
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
  /** Protobuf field number, preserved by schema imports (Field.fieldNumber). */
  fieldNumber?: number | null;
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

  // The details arrive from the browser untyped: a payload that is not an object, or whose name is not a string, is a
  // validation failure here instead of a TypeError further down.
  if (!isPlainObject(data)) return { error: "Entity details are required", code: "VALIDATION_ERROR" };
  const { name, description, fields } = data;

  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "Entity name is required" };
  }

  if (name.length > 128) {
    return { error: "Entity name must be 128 characters or less" };
  }

  try {
    // Ownership of the PARENT: the domain must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("domain", domainId))) return { ...notFoundFailure("Domain") };

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
    return { ...unexpectedFailure("createEntityWithFieldsAction", e) };
  }
}

export async function createEntityAction(domainId: string, formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }

  const name = formData instanceof FormData ? formData.get("name") : null;
  const rawDescription = formData instanceof FormData ? formData.get("description") : null;
  const description = typeof rawDescription === "string" ? rawDescription : "";

  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: "Entity name is required" };
  }

  if (name.length > 128) {
    return { error: "Entity name must be 128 characters or less" };
  }

  try {
    // Ownership of the PARENT: the domain must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("domain", domainId))) return { ...notFoundFailure("Domain") };

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
    return { ...unexpectedFailure("createEntityAction", e) };
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

  const id = requireId(modelId, "Model id");
  if (!id.success) return failure(id.error);
  const input = readFields(
    data,
    { name: isString, type: isString, nullable: optional(isBoolean), isKey: optional(isBoolean), description: optional(isString) },
    "a model field"
  );
  if (!input.success) return failure(input.error);
  const name = trimmedName(input.data.name, "Field");
  if (!name.success) return failure(name.error);

  try {
    // Ownership of the PARENT: the model's domain must belong to the active tenant; anything else reads as missing.
    const model = await prisma.modelDefinition.findUnique({
      where: { id: id.data },
      select: { domain: { select: { tenantId: true } }, _count: { select: { fields: true } } },
    });
    if (!model || !(await isInActiveTenant(model.domain.tenantId))) return { ...notFoundFailure("Model") };

    await prisma.modelFieldDefinition.create({
      data: {
        modelId: id.data,
        name: name.data,
        type: input.data.type as string,
        nullable: (input.data.nullable as boolean | undefined) ?? true,
        isKey: (input.data.isKey as boolean | undefined) ?? false,
        description: (input.data.description as string | undefined) ?? "",
        sortOrder: model._count.fields,
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `Field "${name.data}" already exists`, code: "NAME_CONFLICT" };
    }
    return { ...unexpectedFailure("addModelFieldAction", e) };
  }
}

/**
 * Editable columns of a model field. `modelId` (the move-to-another-model column), `sortOrder` and every other column are
 * deliberately absent: an update that names anything else is rejected with VALIDATION_ERROR.
 */
const MODEL_FIELD_EDITABLE = {
  name: isString, type: isString, nullable: isBoolean, isKey: isBoolean, description: isString,
};

export async function updateModelFieldAction(
  fieldId: string,
  data: { name?: string; type?: string; nullable?: boolean; isKey?: boolean; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(fieldId, "Field id");
  if (!id.success) return failure(id.error);
  const picked = pickEditable(data, MODEL_FIELD_EDITABLE, "a model field");
  if (!picked.success) return failure(picked.error);
  if (picked.data.name !== undefined) {
    const name = trimmedName(picked.data.name, "Field");
    if (!name.success) return failure(name.error);
    picked.data.name = name.data;
  }

  try {
    // Ownership: the field's model's domain must belong to the caller's active tenant; anything else reads as missing.
    const row = await prisma.modelFieldDefinition.findUnique({
      where: { id: id.data },
      select: { model: { select: { domain: { select: { tenantId: true } } } } },
    });
    if (!row || !(await isInActiveTenant(row.model.domain.tenantId))) return { ...notFoundFailure("Field") };

    await prisma.modelFieldDefinition.update({ where: { id: id.data }, data: picked.data as Prisma.ModelFieldDefinitionUpdateInput });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `Field "${picked.data.name}" already exists`, code: "NAME_CONFLICT" };
    }
    return { ...unexpectedFailure("updateModelFieldAction", e) };
  }
}

export async function deleteModelFieldAction(fieldId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(fieldId, "Field id");
  if (!id.success) return failure(id.error);

  try {
    // Ownership: the field's model's domain must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("modelField", id.data))) return { ...notFoundFailure("Field") };
    await prisma.modelFieldDefinition.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteModelFieldAction", e) };
  }
}

// ---------------------------------------------------------------------------
// Entity delete
// ---------------------------------------------------------------------------

/** What the delete toast shows for a blocked entity: the service message plus its one-line remedy. */
const inUseText = (e: ServiceError) => (e.suggestedFix ? `${e.message}${/[.!?]$/.test(e.message) ? "" : "."} ${e.suggestedFix}` : e.message);

export async function deleteEntityAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  // Declared outside the try: the catch explains a P2003 for this very entity.
  let entity: { id: string; name: string; tenantId: string } | null = null;
  try {
    const currentUserId = await resolveCurrentUserId(session.user);

    // Verify the entity exists before attempting delete
    entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { id: true, name: true, tenantId: true },
    });
    // An entity of another tenant reads exactly like a missing one (same answer, nothing deleted).
    if (!entity || !(await isInActiveTenant(entity.tenantId))) return { error: "Entity not found" };

    // Messages / traits that pin it, and other entities whose published versions reference one of its versions (no FK:
    // only this guard stops that delete and leaves a dangling edge that breaks rendering of the referencing version).
    const inUse = await explainEntityDeleteFailure(prisma, entity);
    if (inUse) return { error: inUseText(inUse) };

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
    // P2003 (a pin that landed since the check) -> IN_USE by name; lock timeout / deadlock -> retryable CONFLICT; anything
    // else -> the generic message (the driver text is logged, never shown).
    return { error: inUseText(await entityDeleteFailure(prisma, entity ?? { id: entityId }, e)) };
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
  const input = readFields(data, { name: isString, values: isStringArray, description: optional(isString) }, "an enum");
  if (!input.success) return failure(input.error);
  const name = trimmedName(input.data.name, "Enum");
  if (!name.success) return failure(name.error);
  try {
    const scopeTarget = await dataTypeTarget(domainId, target);
    if (!scopeTarget.success) return failure(scopeTarget.error);
    // A DOMAIN / PRODUCT target is a client id: it must lie in the active tenant (a foreign one reads exactly like a missing one).
    const notOwned = await foreignTarget(scopeTarget.data);
    if (notOwned) return { ...notOwned };
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget.data,
      name: name.data,
      write: (tx, scope) =>
        tx.sharedEnum.create({
          data: { name: name.data, values: input.data.values as string[], description: (input.data.description as string | undefined) ?? "", ...scope },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("createSharedEnumAction", e) };
  }
}

export async function deleteSharedEnumAction(enumId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const id = requireId(enumId, "Enum id");
  if (!id.success) return failure(id.error);
  try {
    // Ownership: the data type must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("sharedEnum", id.data))) return { ...notFoundFailure("Enum") };
    await prisma.sharedEnum.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteSharedEnumAction", e) };
  }
}

/**
 * Editable columns of an enum / scalar / union. Placement (`tenantId` / `domainId` / `productId`), `id`, timestamps and
 * `name` are deliberately absent: a data type has no move or rename path through these actions (a rename would have to go
 * through the line-unique name registry), so an update that names any of them is rejected with VALIDATION_ERROR.
 */
const ENUM_EDITABLE = { values: isStringArray, description: isString };
const SCALAR_EDITABLE = { baseType: isString, format: isStringOrNull, pattern: isStringOrNull, description: isString };
const UNION_EDITABLE = { memberTypes: isStringArray, description: isString };

export async function updateSharedEnumAction(
  enumId: string,
  data: { values?: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(enumId, "Enum id");
  if (!id.success) return failure(id.error);
  const picked = pickEditable(data, ENUM_EDITABLE, "an enum");
  if (!picked.success) return failure(picked.error);

  try {
    const row = await prisma.sharedEnum.findUnique({ where: { id: id.data }, select: { tenantId: true } });
    if (!row || !(await isInActiveTenant(row.tenantId))) return { ...notFoundFailure("Enum") };
    await prisma.sharedEnum.update({ where: { id: id.data }, data: picked.data as Prisma.SharedEnumUpdateInput });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateSharedEnumAction", e) };
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
  const input = readFields(
    data,
    { name: isString, baseType: isString, format: optional(isStringOrNull), pattern: optional(isStringOrNull), description: optional(isString) },
    "a scalar"
  );
  if (!input.success) return failure(input.error);
  const name = trimmedName(input.data.name, "Scalar");
  if (!name.success) return failure(name.error);
  try {
    const scopeTarget = await dataTypeTarget(domainId, target);
    if (!scopeTarget.success) return failure(scopeTarget.error);
    // A DOMAIN / PRODUCT target is a client id: it must lie in the active tenant (a foreign one reads exactly like a missing one).
    const notOwned = await foreignTarget(scopeTarget.data);
    if (notOwned) return { ...notOwned };
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget.data,
      name: name.data,
      write: (tx, scope) =>
        tx.customScalar.create({
          data: {
            name: name.data,
            baseType: input.data.baseType as string,
            format: (input.data.format as string | null | undefined) ?? null,
            pattern: (input.data.pattern as string | null | undefined) ?? null,
            description: (input.data.description as string | undefined) ?? "",
            ...scope,
          },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("createCustomScalarAction", e) };
  }
}

export async function deleteCustomScalarAction(scalarId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const id = requireId(scalarId, "Scalar id");
  if (!id.success) return failure(id.error);
  try {
    // Ownership: the data type must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("customScalar", id.data))) return { ...notFoundFailure("Scalar") };
    await prisma.customScalar.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteCustomScalarAction", e) };
  }
}

export async function updateCustomScalarAction(
  scalarId: string,
  data: { baseType?: string; format?: string | null; pattern?: string | null; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(scalarId, "Scalar id");
  if (!id.success) return failure(id.error);
  const picked = pickEditable(data, SCALAR_EDITABLE, "a scalar");
  if (!picked.success) return failure(picked.error);

  try {
    const row = await prisma.customScalar.findUnique({ where: { id: id.data }, select: { tenantId: true } });
    if (!row || !(await isInActiveTenant(row.tenantId))) return { ...notFoundFailure("Scalar") };
    await prisma.customScalar.update({ where: { id: id.data }, data: picked.data as Prisma.CustomScalarUpdateInput });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateCustomScalarAction", e) };
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
  const input = readFields(data, { name: isString, memberTypes: isStringArray, description: optional(isString) }, "a union");
  if (!input.success) return failure(input.error);
  const name = trimmedName(input.data.name, "Union");
  if (!name.success) return failure(name.error);
  try {
    const scopeTarget = await dataTypeTarget(domainId, target);
    if (!scopeTarget.success) return failure(scopeTarget.error);
    // A DOMAIN / PRODUCT target is a client id: it must lie in the active tenant (a foreign one reads exactly like a missing one).
    const notOwned = await foreignTarget(scopeTarget.data);
    if (notOwned) return { ...notOwned };
    const result = await createInScope(prisma, {
      kind: "dataType",
      target: scopeTarget.data,
      name: name.data,
      write: (tx, scope) =>
        tx.unionType.create({
          data: { name: name.data, memberTypes: input.data.memberTypes as string[], description: (input.data.description as string | undefined) ?? "", ...scope },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("createUnionTypeAction", e) };
  }
}

export async function deleteUnionTypeAction(unionId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const id = requireId(unionId, "Union id");
  if (!id.success) return failure(id.error);
  try {
    // Ownership: the data type must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("unionType", id.data))) return { ...notFoundFailure("Union") };
    await prisma.unionType.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteUnionTypeAction", e) };
  }
}

export async function updateUnionTypeAction(
  unionId: string,
  data: { memberTypes?: string[]; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(unionId, "Union id");
  if (!id.success) return failure(id.error);
  const picked = pickEditable(data, UNION_EDITABLE, "a union");
  if (!picked.success) return failure(picked.error);

  try {
    const row = await prisma.unionType.findUnique({ where: { id: id.data }, select: { tenantId: true } });
    if (!row || !(await isInActiveTenant(row.tenantId))) return { ...notFoundFailure("Union") };
    await prisma.unionType.update({ where: { id: id.data }, data: picked.data as Prisma.UnionTypeUpdateInput });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateUnionTypeAction", e) };
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
  const input = readFields(
    data,
    {
      name: isString,
      description: optional(isString),
      basePath: optional(isString),
      scope: (v) => v === "DOMAIN" || v === "ENTITY",
      entityId: optional(isStringOrNull),
    },
    "an API"
  );
  if (!input.success) return failure(input.error);
  const name = trimmedName(input.data.name, "API");
  if (!name.success) return failure(name.error);
  const scope = input.data.scope as "DOMAIN" | "ENTITY";
  const entityId = input.data.entityId as string | null | undefined;

  try {
    // An entity-scoped API lives at its entity's product scope; any passed target is ignored. That entity must belong to
    // the active tenant (`resolveEntityApiTarget`); every other target is validated, and its domain / product checked below.
    let apiTarget: ScopeTarget;
    if (scope === "ENTITY") {
      const derived = await resolveEntityApiTarget(entityId);
      if ("error" in derived) return { error: derived.error };
      apiTarget = derived.target;
    } else {
      const parsed = parseScopeTarget(target);
      if (!parsed.success) return failure(parsed.error);
      // A TENANT target is never taken from the client (same rule as data types); an API cannot live there anyway.
      apiTarget = parsed.data.level === "TENANT" ? { level: "TENANT", tenantId: await getActiveTenantId() } : parsed.data;
    }
    const notOwned = await foreignTarget(apiTarget);
    if (notOwned) return { ...notOwned };

    const result = await createInScope(prisma, {
      kind: "api",
      target: apiTarget,
      name: name.data,
      write: (tx, placement) =>
        tx.serviceDefinition.create({
          data: {
            name: name.data,
            description: (input.data.description as string | undefined) ?? "",
            basePath: (input.data.basePath as string | undefined) ?? "/",
            ...requireApiPlacement(placement),
            scope,
            entityId: scope === "ENTITY" ? (entityId ?? undefined) : undefined,
          },
        }),
    });
    if (!result.success) return { error: result.error.message };
    revalidatePath("/schemas");
    return { success: true, serviceId: result.data.id };
  } catch (e: unknown) {
    return { ...unexpectedFailure("createServiceAction", e) };
  }
}

// Entity API tab calls this once, on the first operation it adds, so each
// entity gets a single implicit ENTITY-scoped service to hang operations off.
// The service lives at its entity's own level: product-level entities get a
// product-level API, and tenant-level (Enterprise) entities cannot own one.
export async function getOrCreateEntityServiceAction(_domainId: string, entityId: string, entityName: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  if (typeof entityName !== "string") return failure({ code: "VALIDATION_ERROR", message: "Entity name is required" });
  try {
    // The entity is resolved (and checked against the active tenant) BEFORE the existing-service lookup: the lookup
    // would otherwise hand the service id of another tenant's entity to whoever guessed the entity id.
    const derived = await resolveEntityApiTarget(entityId);
    if ("error" in derived) return { error: derived.error };

    const existing = await prisma.serviceDefinition.findFirst({
      where: { entityId },
      select: { id: true },
    });
    if (existing) return { success: true, serviceId: existing.id };

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
    return { ...unexpectedFailure("getOrCreateEntityServiceAction", e) };
  }
}

export async function deleteServiceAction(serviceId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const id = requireId(serviceId, "Service id");
  if (!id.success) return failure(id.error);
  try {
    // Ownership: the API must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("service", id.data))) return { ...notFoundFailure("API service") };
    await prisma.serviceDefinition.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteServiceAction", e) };
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

const isOperationParam = (v: unknown) =>
  isPlainObject(v) &&
  isString((v as Record<string, unknown>).name) &&
  isString((v as Record<string, unknown>).type) &&
  isString((v as Record<string, unknown>).location) &&
  isBoolean((v as Record<string, unknown>).required) &&
  optional(isString)((v as Record<string, unknown>).description);

const isOperationResponse = (v: unknown) =>
  isPlainObject(v) &&
  isInt((v as Record<string, unknown>).statusCode) &&
  optional(isStringOrNull)((v as Record<string, unknown>).type) &&
  optional(isString)((v as Record<string, unknown>).description);

const isListOf = (check: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(check);

/**
 * The editor's operation payload, checked at runtime (it arrives from the browser untyped): a missing or malformed
 * `parameters` / `responses` list, a non-string name... is a VALIDATION_ERROR here, never a TypeError ("Cannot read
 * properties of undefined") or a Prisma validation message further down. The name is trimmed and must not be blank.
 */
function readOperationDetails(data: unknown, listsRequired: boolean) {
  const lists = listsRequired
    ? { parameters: isListOf(isOperationParam), responses: isListOf(isOperationResponse) }
    : { parameters: optional(isListOf(isOperationParam)), responses: optional(isListOf(isOperationResponse)) };
  const input = readFields(
    data,
    { name: isString, httpMethod: isString, httpPath: isString, description: optional(isString), ...lists },
    "an operation"
  );
  if (!input.success) return input;
  const name = trimmedName(input.data.name, "Operation");
  if (!name.success) return name;
  return ok({
    name: name.data,
    httpMethod: input.data.httpMethod as string,
    httpPath: input.data.httpPath as string,
    description: (input.data.description as string | undefined) ?? "",
    parameters: ((input.data.parameters as OperationParamInput[] | undefined) ?? []).map((p) => ({
      name: p.name,
      type: p.type,
      location: p.location,
      required: p.required,
      description: p.description ?? "",
    })),
    responses: ((input.data.responses as OperationResponseInput[] | undefined) ?? []).map((r) => ({
      statusCode: r.statusCode,
      type: r.type ?? null,
      description: r.description ?? "",
    })),
  });
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

  const id = requireId(serviceId, "Service id");
  if (!id.success) return failure(id.error);
  const details = readOperationDetails(data, false);
  if (!details.success) return failure(details.error);

  try {
    // Ownership of the PARENT: the API must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("service", id.data))) return { ...notFoundFailure("API service") };

    const created = await prisma.operation.create({
      data: {
        serviceId: id.data,
        name: details.data.name,
        httpMethod: details.data.httpMethod,
        httpPath: details.data.httpPath,
        description: details.data.description,
        parameters: { create: details.data.parameters },
        responses: { create: details.data.responses },
      },
    });
    revalidatePath("/schemas");
    return { success: true, operationId: created.id };
  } catch (e: unknown) {
    return { ...unexpectedFailure("createOperationAction", e) };
  }
}

/**
 * Editable columns of an operation. `serviceId` (the move-to-another-API column), `decorators` and everything else are
 * deliberately absent: an update that names anything else is rejected with VALIDATION_ERROR.
 */
const OPERATION_EDITABLE = { name: isString, httpMethod: isString, httpPath: isString, description: isString };

export async function updateOperationAction(
  operationId: string,
  data: { name?: string; httpMethod?: string; httpPath?: string; description?: string }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const id = requireId(operationId, "Operation id");
  if (!id.success) return failure(id.error);
  const picked = pickEditable(data, OPERATION_EDITABLE, "an operation");
  if (!picked.success) return failure(picked.error);
  if (picked.data.name !== undefined) {
    const name = trimmedName(picked.data.name, "Operation");
    if (!name.success) return failure(name.error);
    picked.data.name = name.data;
  }

  try {
    // Ownership: the operation's API must belong to the caller's active tenant; anything else reads as missing.
    const row = await prisma.operation.findUnique({ where: { id: id.data }, select: { service: { select: { tenantId: true } } } });
    if (!row || !(await isInActiveTenant(row.service.tenantId))) return { ...notFoundFailure("Operation") };
    await prisma.operation.update({ where: { id: id.data }, data: picked.data as Prisma.OperationUpdateInput });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateOperationAction", e) };
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

  const id = requireId(operationId, "Operation id");
  if (!id.success) return failure(id.error);
  // Both lists are required here (the editor always sends the complete lists): a missing one is a validation failure.
  const details = readOperationDetails(data, true);
  if (!details.success) return failure(details.error);

  try {
    // Ownership: the operation's API must belong to the active tenant; anything else reads as missing. Checked before the
    // batch: its first statements delete the operation's parameters and responses.
    if (!(await inActiveTenant("operation", id.data))) return { ...notFoundFailure("Operation") };

    await prisma.$transaction([
      prisma.operationParameter.deleteMany({ where: { operationId: id.data } }),
      prisma.operationResponse.deleteMany({ where: { operationId: id.data } }),
      prisma.operation.update({
        where: { id: id.data },
        data: {
          name: details.data.name,
          httpMethod: details.data.httpMethod,
          httpPath: details.data.httpPath,
          description: details.data.description,
          parameters: { create: details.data.parameters },
          responses: { create: details.data.responses },
        },
      }),
    ]);
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("replaceOperationDetailsAction", e) };
  }
}

export async function deleteOperationAction(operationId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };
  const id = requireId(operationId, "Operation id");
  if (!id.success) return failure(id.error);
  try {
    // Ownership: the operation's API must belong to the active tenant; anything else reads as missing.
    if (!(await inActiveTenant("operation", id.data))) return { ...notFoundFailure("Operation") };
    await prisma.operation.delete({ where: { id: id.data } });
    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteOperationAction", e) };
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
  /** Format the assets were imported from (ModelDefinition.sourceFormat); defaults to "typespec". */
  sourceFormat?: string;
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
    /** Model tags from the import (TypeSpec `x-tags`), stored as the entity's metadata.tags. */
    tags?: string[];
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

/**
 * A failed placement / scope / registry Result thrown out of the import transaction (so it rolls back): its message is
 * user-facing and reaches the dialog. An opaque failure (`DB_ERROR` / `INTERNAL_ERROR`) is a plain Error instead: the catch
 * answers it generically.
 */
function rejection(error: ServiceError): Error {
  return isOpaqueErrorCode(error.code) ? new Error(error.message) : new ServiceErrorRejection(error);
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
  // Events kinds are never produced by this importer, but the label map must cover every RegistryKind.
  trait: "Trait",
  message: "Message",
  channel: "Channel",
  eventSpec: "Event Spec",
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
  // The payload arrives from the browser untyped: anything but an object is refused before a property is read (a null payload
  // would otherwise surface as "Cannot read properties of null").
  if (!isPlainObject(payload)) return emptyImportResult(["The import payload must be an object"]);

  // Skip messages accumulated so far; kept outside the transaction so a later
  // failure can report them alongside its own error.
  const skipped: string[] = [];

  try {
    const currentUserId = await resolveCurrentUserId(session.user);

    // The import writes into the payload's domain (and, through it, its products): that domain must belong to the active
    // tenant. A foreign domain reads exactly like a missing one (same message), before anything is created.
    const notOwned = await foreignTarget({ level: "DOMAIN", domainId: payload.domainId });
    if (notOwned) return emptyImportResult([notOwned.error]);

    const imported = await prisma.$transaction(async (tx) => {
      const result = emptyImportResult(skipped); // errors aliases `skipped`

      // 1. Resolve + validate every scope before the first create.
      const domainScope = await resolveScope(tx, { level: "DOMAIN", domainId: payload.domainId });
      if (!domainScope.success) throw rejection(domainScope.error);
      const dataTypeScope = validateScope("dataType", domainScope.data);
      if (!dataTypeScope.success) throw rejection(dataTypeScope.error);
      const apiScope = validateScope("api", domainScope.data);
      if (!apiScope.success) throw rejection(apiScope.error);
      const { tenantId } = domainScope.data;

      // Serialize name checks + writes for this tenant (spec §4.3).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

      const importProductId =
        payload.productId ?? (await ensureDefaultProductId(payload.domainId, tx));
      const productScope = await resolveScope(tx, { level: "PRODUCT", productId: importProductId });
      if (!productScope.success) throw rejection(productScope.error);
      if (productScope.data.domainId !== payload.domainId) {
        throw new ServiceErrorRejection({ code: "INVALID_SCOPE", message: "Product does not belong to this domain" });
      }
      const entityScope = validateScope("entity", productScope.data);
      if (!entityScope.success) throw rejection(entityScope.error);

      // Registry check right before each create, so later checks also see this batch's
      // earlier rows. Returns true when the asset is free; on a conflict it records the
      // skip and returns false. A failed check (DB_ERROR) aborts the whole import.
      const isNameFree = async (kind: RegistryKind, name: string, scope: LevelScope) => {
        const free = await assertNameAvailable(tx, { name, ...scope });
        if (free.success) return true;
        if (free.error.code !== "NAME_CONFLICT") throw rejection(free.error);
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
            sourceFormat: payload.sourceFormat ?? "typespec",
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

      // Names are trimmed before BOTH the registry check and the write: the registry compares trimmed names, so an
      // untrimmed stored name ("Foo ") would slip past a later "Foo" and break line uniqueness.
      for (const sharedEnum of payload.sharedEnums) {
        const name = sharedEnum.name.trim();
        if (!(await isNameFree("sharedEnum", name, domainScope.data))) continue;
        await tx.sharedEnum.create({
          data: {
            name,
            values: sharedEnum.values,
            description: sharedEnum.description ?? "",
            ...domainScope.data,
          },
        });
        result.enumsCreated++;
      }

      for (const scalar of payload.customScalars) {
        const name = scalar.name.trim();
        if (!(await isNameFree("customScalar", name, domainScope.data))) continue;
        await tx.customScalar.create({
          data: {
            name,
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
        const name = unionType.name.trim();
        if (!(await isNameFree("unionType", name, domainScope.data))) continue;
        await tx.unionType.create({
          data: {
            name,
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
            ...(entity.tags && entity.tags.length > 0 ? { metadata: { tags: entity.tags } } : {}),
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

        if (!(await isNameFree("service", service.name.trim(), serviceScope))) continue;
        await tx.serviceDefinition.create({
          data: {
            name: service.name.trim(),
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
    // The transaction rolled back (or never started): nothing from this import exists, so report zero counts with every skip
    // message so far plus the cause. Only a user-facing rejection (placement / scope / registry: `ServiceErrorRejection`) and
    // the stale session say what happened; anything else (a driver or Prisma error, a malformed payload's TypeError) is
    // logged server-side and answered generically (Next control-flow errors are re-thrown first).
    const message =
      e instanceof AuditUserMissingError
        ? STALE_SESSION_IMPORT_ERROR
        : e instanceof ServiceErrorRejection
          ? e.message
          : unexpectedFailure("createDomainAssetsFromImportAction", e).error;
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
  if (!isPlainObject(payload)) return emptyImportResult(["The import payload must be an object"]);
  return createDomainAssetsFromImportAction({
    namespace: payload.namespace,
    models: payload.models ?? [],
    services: payload.services ?? [],
    decoratorDefinitions: payload.decoratorDefinitions ?? [],
    ...payload,
  });
}
