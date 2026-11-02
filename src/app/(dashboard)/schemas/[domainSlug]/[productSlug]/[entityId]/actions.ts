"use server";

import { activeDanglingRef, decoratorsAfterFieldEdit } from "@/lib/field-dangling";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { withAudit, recordAuditFailure } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug } from "@/lib/slug";
import { firstReservedFieldNameMessage, reservedFieldNameMessage, reservedNameMessage } from "@/lib/reserved-field-names";
import { TypeSpecDecoratorSchema } from "@/types/schemas/typespec-decorator.schema";
import { updateEntity, type UpdateEntityPatch } from "@/services/entity.service";
import type { Relationship } from "@/types/schemas/entity-metadata.schema";
import type { DiffResult } from "@/services/version-history/version.types";
import { can, entityReader, type ActionId, type ResourceRef } from "@/lib/access";
import { redactSchemaVersions } from "@/lib/access/schema-version-redaction";
import type { Principal } from "@/lib/access/principal";
import { authorizeSubject, contextOf, failureOf, guardActiveTenant, guardSubject, notFoundFailure, unexpectedFailure } from "@/lib/action-context";
import {
  isBoolean, isInt, isIntOrNull, isPlainObject, isString, isStringArray, isStringOrNull, pickEditable,
} from "@/lib/editable-fields";
import { requireId } from "@/services/events/service-guards";
import { err, ok, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { TENANT_PLACEHOLDER, holdsEntityReference, readFieldReference, upgradeLegacyReference, writeFieldReference } from "@/lib/references/entity-reference";
import { loadReferenceClosure, loadTenantEntityRefs, type LegacyUpgrade, type ResolveMode } from "@/lib/references/closure";
import {
  MAX_WRITTEN_NAMES,
  createNameResolver,
  resolveSourceReferences,
  storedReferenceNames,
  type SourceReference,
} from "@/lib/references/source-reference";
import type { PublishNeedsReference } from "@/lib/entity-versioning/publish-plan";
import { TYPESPEC_STD_TYPE_NAMES } from "@/lib/compiler/typespec-identifiers";
import { draftReferencedEntities, draftReferenceRefusal } from "@/lib/entity-versioning/schema-version-publishability";
import { getActiveTenantId } from "@/lib/active-tenant";
import type { ClosureTargetResult } from "@/lib/emission/closure-generation";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";
import { formatVersionLabel, parseVersionLabel } from "@/lib/entity-versioning/version-math";
import {
  buildSchemaTargetFieldMappings,
  parseSchemaTargetTypeOverrides,
  removeFieldTargetTypeOverride,
  toFieldOverridePolicies,
  upsertFieldTargetTypeOverride,
  type FieldTargetTypeOverride,
  type SchemaTargetTypeOverrides,
} from "@/lib/schema-targets/field-type-overrides";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import type { FieldTypeMapping, SchemaVersion, SchemaVersionResolution, SchemaVersionsMap } from "@/types/schema-version";
import {
  getTargetRequirements,
  primaryKeyIneligibility,
  hasTargetRequirements,
  type MissingRequirement,
  type RequirementEntityShape,
} from "@/lib/schema-targets/requirements";
import { requirementFromDiagnostic, structuredDiagnostics } from "@/lib/typespec-official/emitter-diagnostics";
import {
  environmentDriftVerdict,
  getDeploymentStatus,
  markAsDeployed,
  updateDriftStatus,
  type DeploymentStatus,
} from "@/services/deployment.service";
import { getTargetTypeCatalogEntry } from "@/lib/type-mapping/target-type-catalog";
import { getOverridesForEntity } from "@/services/type-mapping.service";
import {
  compileTypeSpecWithGovernance,
  type FieldGovernanceInfo,
  type GovernanceDiagnostic,
} from "@/lib/compiler/typespec-compiler";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { fieldNeedsUpdate, mergeSyncedField, entityExtensionsChange } from "@/lib/typespec-sync/merge-fields";
import { isDecimalType } from "@/lib/data-types";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";
import { FOREIGN_REFERENCE_MESSAGE, referencedEntityAllowed } from "@/lib/references/foreign-reference-guard";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import {
  markEntityDraftChanged,
  metadataChangesDraft,
  isSourceStale,
  withSourceStale,
  CLEAR_SOURCE_STALE_SQL,
  SET_ENTITY_TAGS_SQL,
  SET_ENTITY_EXTENSIONS_SQL,
  CLEAR_ENTITY_EXTENSIONS_SQL,
  MARK_DRAFT_CHANGED_SQL,
} from "@/lib/entity-versioning/draft-state";

/**
 * May the caller READ the entity `id`? What an entity id written inside a field's decorators (a reference) must satisfy: it is what publish
 * pins and the renderers load, so it must be an entity of the ACTIVE tenant the caller can see (a domain-scoped role does not reach another
 * domain's entity), judged by the policy like every other read.
 */
async function readableEntity(id: string): Promise<boolean> {
  return (await authorizeSubject("entity.read", { kind: "entity", id })).success;
}

/**
 * What a call to `updateEntityMetadataAction` must be allowed for each key it names (the metadata is a JSON document and the action merges
 * a patch into it): the entity's own bookkeeping (tags, owner, custom properties) is an edit; what carries the STATE of a release or of the
 * lifecycle is not, and needs the very action that changes that state (`entity.publish` and `deploy.run` for the stored schema versions, which
 * hold draft / published / deployed; `entity.lifecycle` for the deprecation notice; `retention.write` for the retention policy). A key that is
 * not listed (server-owned bookkeeping such as `sourceStale`, `importedFrom`, `sourceFormat`, `hasUnpublishedChanges`) cannot be set from here at
 * all: the server writes those itself.
 */
const METADATA_KEY_ACTIONS: Readonly<Record<string, readonly ActionId[]>> = Object.freeze({
  tags: ["entity.write"],
  owner: ["entity.write"],
  custom: ["entity.write"],
  retentionPolicy: ["retention.write"],
  deprecation: ["entity.lifecycle"],
  schemaVersions: ["entity.publish", "deploy.run"],
  schemaTargetTypeOverrides: ["typemapping.entity"],
});

/**
 * A field name must be a non-blank string and is stored trimmed: the slug and the name the editor shows both come from the
 * trimmed text, so a padded or blank name (`FieldCard` sends the raw blur value) is never persisted.
 */
function trimmedFieldName(value: unknown): { name: string } | { error: string; code: "VALIDATION_ERROR" } {
  if (typeof value !== "string" || value.trim() === "") return { error: "Field name is required", code: "VALIDATION_ERROR" };
  return { name: value.trim() };
}

/** A name for a field that does not exist yet (or is being renamed): `trimmedFieldName`, and not a name the AsyncAPI parser cannot read. */
function newFieldName(value: unknown): { name: string } | { error: string; code: "VALIDATION_ERROR" } {
  const fieldName = trimmedFieldName(value);
  if ("error" in fieldName) return fieldName;
  const reserved = reservedFieldNameMessage(fieldName.name);
  return reserved === null ? fieldName : { error: reserved, code: "VALIDATION_ERROR" };
}

/**
 * The name of the field of `entityId` that holds the URL name of `name` (`Order ID` holds `order-id`, which `order_id` slugs to as well), or
 * undefined when no field does. A refused duplicate names that field rather than the name that was typed; `exceptFieldId` leaves one field out.
 */
async function fieldHoldingSlug(entityId: string, name: string, exceptFieldId?: string): Promise<string | undefined> {
  try {
    const holder = await prisma.field.findFirst({
      where: { entityId, slug: generateSlug(name), ...(exceptFieldId !== undefined && { id: { not: exceptFieldId } }) },
      select: { name: true },
    });
    return holder?.name;
  } catch {
    // The wording is a refinement of the refusal: when this lookup fails, the plain message stands.
    return undefined;
  }
}

export async function addFieldAction(
  entityId: string,
  name: string,
  type: string,
  opts?: {
    description?: string;
    classification?: string | null;
    nullable?: boolean;
    isKey?: boolean;
    precision?: number | null;
    scale?: number | null;
    fieldNumber?: number | null;
    aliases?: string[];
    decorators?: Record<string, unknown>;
  }
) {

  const fieldName = newFieldName(name);
  if ("error" in fieldName) return fieldName;
  if (typeof type !== "string") return { error: "Field type is required", code: "VALIDATION_ERROR" };

  try {
    // Ownership of the PARENT: the entity must belong to the active tenant; anything else reads as missing. Checked before
    // every other read: the lookups below would otherwise answer a foreign entity's field numbers.
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const maxField = await prisma.field.findFirst({
      where: { entityId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    // Validate typespec sub-key if present on create
    if (opts?.decorators?.typespec) {
      const validation = TypeSpecDecoratorSchema.safeParse(opts.decorators.typespec);
      if (!validation.success) {
        return { error: `Invalid TypeSpec decorators: ${validation.error.message}` };
      }
    }

    // The entity id inside the decorators is what publish pins and the renderers load: it must be an entity of the active tenant.
    if (!(await referencedEntityAllowed(opts?.decorators, undefined, readableEntity))) {
      return { error: FOREIGN_REFERENCE_MESSAGE, code: "VALIDATION_ERROR" as const };
    }

    // Auto-assign field number if not provided
    let assignedFieldNumber = opts?.fieldNumber ?? null;
    if (assignedFieldNumber == null) {
      const maxFieldNumber = await prisma.field.findFirst({
        where: { entityId, fieldNumber: { not: null } },
        orderBy: { fieldNumber: "desc" },
        select: { fieldNumber: true },
      });
      if (maxFieldNumber?.fieldNumber != null) {
        assignedFieldNumber = maxFieldNumber.fieldNumber + 1;
      } else {
        // Fall back to sortOrder + 1 if no field numbers exist
        assignedFieldNumber = (maxField ? maxField.sortOrder + 1 : 0) + 1;
      }
    }

    // Validate field number uniqueness
    if (assignedFieldNumber != null) {
      const conflict = await prisma.field.findFirst({
        where: { entityId, fieldNumber: assignedFieldNumber },
        select: { name: true },
      });
      if (conflict) {
        return { error: `Field number ${assignedFieldNumber} is already assigned to field '${conflict.name}'` };
      }
    }

    const field = await withAudit({
      action: "CREATE",
      entityType: "Field",
      entityId: "pending",
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      fn: async () => {
        // The field write and the draft + stale-source mark are ONE atomic batch: a failure between them can never
        // leave a changed field with `hasUnpublishedChanges` still false (publish would answer NO_CHANGES).
        const [created] = await prisma.$transaction([
          prisma.field.create({
            data: {
              entityId,
              name: fieldName.name,
              slug: generateSlug(fieldName.name),
              type,
              sortOrder: maxField ? maxField.sortOrder + 1 : 0,
              ...(opts?.description != null && { description: opts.description }),
              classification: opts?.classification !== undefined ? opts.classification : "SENSITIVE",
              ...(opts?.nullable != null && { nullable: opts.nullable }),
              ...(opts?.isKey != null && { isKey: opts.isKey }),
              ...(opts?.precision !== undefined && { precision: opts.precision }),
              ...(opts?.scale !== undefined && { scale: opts.scale }),
              fieldNumber: assignedFieldNumber,
              ...(opts?.aliases && { aliases: opts.aliases }),
              ...(opts?.decorators && { decorators: opts.decorators as Prisma.InputJsonValue }),
            },
          }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
        ]);
        return created;
      },
    });
    revalidatePath("/schemas");
    return { success: true, field };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      const holder = await fieldHoldingSlug(entityId, fieldName.name);
      return { error: `Field "${holder ?? fieldName.name}" already exists` };
    }
    // Anything else (a Prisma validation message carries the absolute source path and a code excerpt) is logged, not shown.
    return { ...unexpectedFailure("addFieldAction", e) };
  }
}

/**
 * Editable columns of an entity field (the quick editor and the field studio send exactly these). The drag reorder is `reorderFieldsAction`,
 * which sets every position at once; a single `sortOrder` update is still accepted. `id`, `entityId` (the move-to-another-entity column),
 * `slug` (derived from `name` here), the timestamps and everything else are deliberately absent: an update that names anything else is
 * rejected with VALIDATION_ERROR.
 */
const FIELD_EDITABLE = {
  name: isString,
  type: isString,
  nullable: isBoolean,
  isKey: isBoolean,
  description: isString,
  classification: isStringOrNull,
  precision: isIntOrNull,
  scale: isIntOrNull,
  fieldNumber: isIntOrNull,
  aliases: isStringArray,
  decorators: isPlainObject,
  sortOrder: isInt,
};

export async function updateFieldAction(
  fieldId: string,
  data: {
    name?: string;
    type?: string;
    nullable?: boolean;
    isKey?: boolean;
    description?: string;
    classification?: string | null;
    precision?: number | null;
    scale?: number | null;
    fieldNumber?: number | null;
    aliases?: string[];
    decorators?: Record<string, unknown>;
  }
) {

  const fieldIdCheck = requireId(fieldId, "Field id");
  if (!fieldIdCheck.success) return { error: fieldIdCheck.error.message, code: fieldIdCheck.error.code };
  const picked = pickEditable(data, FIELD_EDITABLE, "a field");
  if (!picked.success) return { error: picked.error.message, code: picked.error.code };
  const { decorators, ...rest } = picked.data as { decorators?: Record<string, unknown> } & Record<string, unknown>;
  // A renamed field is stored trimmed and never blank (the quick editor sends the raw blur value).
  if (rest.name !== undefined) {
    const fieldName = trimmedFieldName(rest.name);
    if ("error" in fieldName) return fieldName;
    rest.name = fieldName.name;
  }

  // The field's entity, once it is read: a duplicate name is then answered with the field that holds the name (see fieldHoldingSlug).
  let entityOfField: string | undefined;
  try {
    // The field's place (its entity's tenant, domain and product) is judged BEFORE anything of it is read: the active tenant AND a covering role.
    const access = await guardSubject("entity.write", { kind: "field", id: fieldId }, { label: "Field" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const existing = await prisma.field.findUnique({ where: { id: fieldId } });
    if (!existing) return { ...notFoundFailure("Field") };
    entityOfField = existing.entityId;

    // A RENAME to a name the AsyncAPI parser cannot read is refused. A name that does not change is not looked at: the field studio sends
    // the name with every other edit, and a field that already has such a name (created before the rule) must stay editable.
    if (typeof rest.name === "string" && rest.name !== existing.name) {
      const reserved = reservedFieldNameMessage(rest.name);
      if (reserved !== null) return { error: reserved, code: "VALIDATION_ERROR" };
    }

    // Regenerate slug when name changes (the slug is server-derived: a client-supplied `slug` was rejected above)
    if (typeof rest.name === "string" && rest.name && rest.name !== existing.name) {
      (rest as Record<string, unknown>).slug = generateSlug(rest.name);
    }

    // Validate typespec sub-key if present
    if (decorators?.typespec) {
      const validation = TypeSpecDecoratorSchema.safeParse(decorators.typespec);
      if (!validation.success) {
        return { error: `Invalid TypeSpec decorators: ${validation.error.message}` };
      }
    }

    // A NEW or CHANGED entity id inside the decorators must be an entity of the active tenant (an id the field already holds is left alone:
    // its entity may have been deleted since, and an unrelated edit of the field must stay possible).
    if (!(await referencedEntityAllowed(decorators, existing.decorators, readableEntity))) {
      return { error: FOREIGN_REFERENCE_MESSAGE, code: "VALIDATION_ERROR" as const };
    }

    // Validate field number uniqueness
    const fieldNumber = rest.fieldNumber as number | null | undefined;
    if (fieldNumber != null) {
      const conflict = await prisma.field.findFirst({
        where: {
          entityId: existing.entityId,
          fieldNumber,
          id: { not: fieldId },
        },
        select: { name: true },
      });
      if (conflict) {
        return { error: `Field number ${fieldNumber} is already assigned to field '${conflict.name}'` };
      }
    }

    // An edit that resolves an unresolved external reference (the type changes away from it, or its target changes) clears the marker.
    const nextDecorators = decoratorsAfterFieldEdit(existing, { type: typeof rest.type === "string" ? rest.type : undefined, decorators });

    await withAudit({
      action: "UPDATE",
      entityType: "Field",
      entityId: fieldId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: existing as unknown as object,
      fn: async () => {
        // The field write and the draft + stale-source mark are ONE atomic batch (see addFieldAction).
        const [updated] = await prisma.$transaction([
          prisma.field.update({
            where: { id: fieldId },
            data: {
              ...(rest as Prisma.FieldUpdateInput),
              ...(nextDecorators !== undefined && { decorators: nextDecorators as Prisma.InputJsonValue }),
            },
          }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, existing.entityId),
        ]);
        return updated;
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      const holder = entityOfField !== undefined && typeof rest.name === "string" ? await fieldHoldingSlug(entityOfField, rest.name, fieldId) : undefined;
      return { error: holder === undefined ? `A field with that name already exists` : `Field "${holder}" already exists` };
    }
    return { ...unexpectedFailure("updateFieldAction", e) };
  }
}

/**
 * Set the order of an entity's fields in one write (the drag reorder). `orderedFieldIds` lists EVERY field of the entity, first to last, and
 * each field takes its index as `sortOrder` (every field is written, in one batch). Judged over the entity like the other field actions
 * (`entity.write` in the active tenant), before any field is read. An order that is not exactly the entity's own fields (one missing,
 * repeated or foreign) is refused and nothing is written. The positions and the draft mark are one atomic batch, and the page is revalidated once.
 */
export async function reorderFieldsAction(entityId: string, orderedFieldIds: string[]) {
  if (!isStringArray(orderedFieldIds)) return { error: "The field order must be a list of field ids", code: "VALIDATION_ERROR" };

  try {
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const stored = await prisma.field.findMany({
      where: { entityId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, sortOrder: true },
    });
    const storedSortOrder = new Map(stored.map((f) => [f.id, f.sortOrder]));
    const requested = new Set(orderedFieldIds);
    // Every field of the entity, once: a missing, repeated or foreign id would leave the order undefined.
    if (requested.size !== orderedFieldIds.length || requested.size !== stored.length || orderedFieldIds.some((id) => !storedSortOrder.has(id))) {
      // The page holds a list from before a field was added or removed by someone else: the page reloads, and the move is tried again.
      return {
        error: "The field list has changed since this page was loaded. It is being reloaded; try the move again.",
        code: "VALIDATION_ERROR",
      };
    }

    if (orderedFieldIds.every((id, index) => storedSortOrder.get(id) === index)) return { success: true };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { fieldOrder: stored.map((f) => f.id) },
      fn: async () => {
        // Every field is written, not only the ones that moved: the stored order was read above, outside this batch, so a subset written
        // from it could leave two fields on one position when another reorder committed in between. Each batch is then a complete order,
        // and the last one to commit is the order. The positions and the draft + stale-source mark are ONE atomic batch (see addFieldAction).
        await prisma.$transaction([
          ...orderedFieldIds.map((id, index) => prisma.field.update({ where: { id }, data: { sortOrder: index } })),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
        ]);
        return { fieldOrder: orderedFieldIds };
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("reorderFieldsAction", e) };
  }
}

/** The metadata keys a lifecycle change may send: the keys whose only action is `entity.lifecycle` in METADATA_KEY_ACTIONS (the deprecation notice). */
const LIFECYCLE_METADATA_KEYS: readonly string[] = Object.keys(METADATA_KEY_ACTIONS).filter((key) =>
  METADATA_KEY_ACTIONS[key].every((action) => action === "entity.lifecycle")
);

export async function updateEntityStatusAction(
  entityId: string,
  status: string,
  metadata?: Record<string, unknown>
): Promise<{ success: true; error?: undefined } | { error: string; code?: string; success?: undefined }> {

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("entity.lifecycle", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const input: Record<string, unknown> = { status };
    if (metadata) {
      // The change is a patch of the lifecycle's own key (the deprecation notice): the service merges it over the stored metadata. Any other key is
      // refused here, as updateEntityMetadataAction refuses it (the same METADATA_KEY_ACTIONS gate), so a lifecycle change cannot set tags, relationships
      // or the keys the server writes.
      if (!isPlainObject(metadata)) return { error: "The metadata changes must be an object", code: "VALIDATION_ERROR" };
      const unknownKey = Object.keys(metadata).find((key) => !LIFECYCLE_METADATA_KEYS.includes(key));
      if (unknownKey !== undefined) return { error: `The metadata key "${unknownKey.slice(0, 64)}" cannot be changed here`, code: "VALIDATION_ERROR" };
      input.metadata = metadata;
    }

    // A patch: its metadata keys may be sent as null (a removal), which the UpdateEntityInput type does not allow.
    const result = await updateEntity(entityId, input as UpdateEntityPatch, contextOf(access.principal));

    if (!result.success) {
      return { ...failureOf(result.error, "updateEntityStatusAction") };
    }

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateEntityStatusAction", e) };
  }
}

/**
 * Update the relationships array in entity metadata JSONB.
 * Used when reference fields are created/updated/deleted.
 */
export async function updateEntityRelationshipsAction(
  entityId: string,
  relationships: Relationship[]
) {

  if (!Array.isArray(relationships)) return { error: "The relationships must be a list", code: "VALIDATION_ERROR" };

  try {
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { ...notFoundFailure("Entity") };

    const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};
    // A relationships edit changes the draft, so the stored TypeSpec source is stale (R45).
    const updatedMeta = withSourceStale(existingMeta, { ...existingMeta, relationships }, true);

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { metadata: existingMeta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateEntityRelationshipsAction", e) };
  }
}

/**
 * Run the full emission pipeline for an entity.
 * Returns TypeSpec source + per-target emitted outputs with validation.
 */
export async function emitEntityAction(entityId: string) {

  try {
    // Ownership: the emitter reads the entity by id and trusts it, so scope it first.
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const { emitEntity } = await import("@/lib/emission/emission.service");
    const { pickRequestOfRefusal } = await import("@/lib/emission/closure-generation");
    // The preview emits the entity with everything it references, limited to what the caller's roles cover (KD-045): otherwise it comes back refused.
    const result = await emitEntity(entityId, entityReader(access.principal.assignments));
    // A name that two entities answer to is a question (the same one a generation asks): answered beside the result so the page can open
    // the pick dialog and run the emission again.
    const needsReference = pickRequestOfRefusal(result.refusal);
    return { success: true, result, ...(needsReference ? { needsReference } : {}) };
  } catch (e: unknown) {
    return { ...unexpectedFailure("emitEntityAction", e) };
  }
}

/**
 * Create a type mapping override (global or per-entity).
 */
export async function createTypeMappingOverrideAction(input: {
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  justification: string;
  scope: "global" | "per-entity";
  entityId: string;
  isLossy: boolean;
}) {

  if (!isPlainObject(input) || (input.scope !== "global" && input.scope !== "per-entity")) {
    return { error: "The override must be global or per-entity", code: "VALIDATION_ERROR" };
  }

  try {
    // A per-entity override names an entity by id: it must belong to the active tenant (a global one names none).
    // A per-entity override is judged over its entity (typemapping.entity); a global one, which reaches every tenant, over the active tenant (typemapping.global).
    const access =
      input.scope === "per-entity"
        ? await guardSubject("typemapping.entity", { kind: "entity", id: input.entityId }, { label: "Entity" })
        : await guardActiveTenant("typemapping.global", { label: "Override" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const { createGlobalOverride, createEntityOverride } = await import(
      "@/services/type-mapping.service"
    );

    const ctx = contextOf(access.principal);

    if (input.scope === "global") {
      const result = await createGlobalOverride(
        {
          sourceType: input.sourceType,
          targetFormat: input.targetFormat,
          mappedType: input.mappedType,
          justification: input.justification,
          isLossy: input.isLossy,
        },
        ctx
      );
      if (!result.success) return { ...failureOf(result.error, "createTypeMappingOverrideAction") };
      revalidatePath("/schemas", "layout");
      return { success: true, override: result.data };
    } else {
      const result = await createEntityOverride(
        {
          sourceType: input.sourceType,
          targetFormat: input.targetFormat,
          mappedType: input.mappedType,
          justification: input.justification,
          isLossy: input.isLossy,
          entityId: input.entityId,
        },
        ctx
      );
      if (!result.success) return { ...failureOf(result.error, "createTypeMappingOverrideAction") };
      revalidatePath("/schemas", "layout");
      return { success: true, override: result.data };
    }
  } catch (e: unknown) {
    return { ...unexpectedFailure("createTypeMappingOverrideAction", e) };
  }
}

/**
 * Acknowledge a lossy type mapping for a specific entity.
 */
export async function acknowledgeLossyMappingAction(input: {
  entityId: string;
  sourceType: string;
  targetFormat: string;
}) {

  if (!isPlainObject(input)) return { error: "The acknowledgement details are required", code: "VALIDATION_ERROR" };

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("typemapping.entity", { kind: "entity", id: input.entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const { acknowledgeLossyMapping } = await import(
      "@/services/type-mapping.service"
    );

    const result = await acknowledgeLossyMapping(input, contextOf(access.principal));

    if (!result.success) return { ...failureOf(result.error, "acknowledgeLossyMappingAction") };
    revalidatePath("/schemas", "layout");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("acknowledgeLossyMappingAction", e) };
  }
}

/**
 * Get version history for an entity.
 */
export async function getVersionHistoryAction(entityId: string) {

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code, versions: [] };

    const { getVersionHistory } = await import(
      "@/services/version-history/version.service"
    );
    const result = await getVersionHistory(entityId, contextOf(access.principal));

    if (!result.success) {
      return { ...failureOf(result.error, "getVersionHistoryAction"), versions: [] };
    }

    return { success: true, versions: result.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getVersionHistoryAction", e), versions: [] };
  }
}

/**
 * Compare two versions and return structured diff result.
 */
export async function compareVersionsAction(
  entityId: string,
  v1: number,
  v2: number
): Promise<{ success: true; diff: DiffResult; error?: undefined } | { error: string; code?: string; success?: undefined; diff?: undefined }> {

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const { compareVersionsStructured } = await import(
      "@/services/version-history/version.service"
    );
    const result = await compareVersionsStructured(entityId, v1, v2, contextOf(access.principal));

    if (!result.success) {
      return { ...failureOf(result.error, "compareVersionsAction") };
    }

    return { success: true, diff: result.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("compareVersionsAction", e) };
  }
}

/**
 * Get change history for an entity (unified timeline of versions + audit entries).
 */
export async function getChangeHistoryAction(
  entityId: string,
  filters?: {
    changeTypes?: string[];
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
  },
  cursor?: string
) {

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const { getChangeHistory } = await import(
      "@/services/change-history.service"
    );
    const parsedFilters = filters
      ? {
          changeTypes: filters.changeTypes as import("@/types/schemas/change-history").ChangeType[] | undefined,
          userId: filters.userId,
          dateFrom: filters.dateFrom ? new Date(filters.dateFrom) : undefined,
          dateTo: filters.dateTo ? new Date(filters.dateTo) : undefined,
        }
      : undefined;

    const result = await getChangeHistory(
      entityId,
      contextOf(access.principal),
      parsedFilters,
      cursor
    );

    if (!result.success) {
      return { ...failureOf(result.error, "getChangeHistoryAction") };
    }

    return {
      success: true,
      entries: result.data.entries,
      hasMore: result.data.hasMore,
      nextCursor: result.data.nextCursor,
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getChangeHistoryAction", e) };
  }
}

/**
 * Generate a TypeSpec preview for an entity.
 * Compiles the entity + fields into a SuperSchemaModel IR, then generates TypeSpec source.
 */
export async function generateTypeSpecPreviewAction(entityId: string) {

  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code, source: "" };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, include: { domain: true } });
    if (!entity) return { ...notFoundFailure("Entity"), source: "" };

    const fields = await prisma.field.findMany({
      where: { entityId },
      orderBy: { sortOrder: "asc" },
    });

    const { compileEntity } = await import("@/lib/compiler/compiler.service");
    const { generateTypeSpec } = await import("@/lib/compiler/typespec-generator");

    // Adapt Prisma entity to PrismaEntityInput shape (add slug derived from name)
    const entityInput = {
      ...entity,
      domain: entity.domain
        ? { ...entity.domain, slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-") }
        : null,
    };
    const model = compileEntity(entityInput, fields);
    const source = generateTypeSpec(model);

    return { success: true, source };
  } catch (e: unknown) {
    return { ...unexpectedFailure("generateTypeSpecPreviewAction", e), source: "" };
  }
}

export async function deleteFieldAction(fieldId: string) {

  const fieldIdCheck = requireId(fieldId, "Field id");
  if (!fieldIdCheck.success) return { error: fieldIdCheck.error.message, code: fieldIdCheck.error.code };

  try {
    // The field's place (its entity's tenant, domain and product) is judged BEFORE anything of it is read: the active tenant AND a covering role.
    const access = await guardSubject("entity.write", { kind: "field", id: fieldId }, { label: "Field" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const existing = await prisma.field.findUnique({ where: { id: fieldId } });
    if (!existing) return { ...notFoundFailure("Field") };

    // If this is a reference field, clean up relationship from entity metadata
    if (existing.type === "reference") {
      const entity = await prisma.entity.findUnique({
        where: { id: existing.entityId },
        select: { metadata: true },
      });
      if (entity?.metadata) {
        const meta = entity.metadata as Record<string, unknown>;
        const relationships = (meta.relationships as Relationship[]) ?? [];
        const filtered = relationships.filter((r) => r.fieldId !== fieldId);
        if (filtered.length !== relationships.length) {
          await prisma.entity.update({
            where: { id: existing.entityId },
            data: {
              metadata: { ...meta, relationships: filtered } as Prisma.InputJsonValue,
            },
          });
        }
      }
    }

    await withAudit({
      action: "DELETE",
      entityType: "Field",
      entityId: fieldId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: existing as unknown as object,
      fn: async () => {
        // Delete + draft / stale-source mark in ONE atomic batch (see addFieldAction).
        await prisma.$transaction([
          prisma.field.delete({ where: { id: fieldId } }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, existing.entityId),
        ]);
        return null;
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deleteFieldAction", e) };
  }
}

// ---------------------------------------------------------------------------
// Bidirectional TypeSpec editing — apply parsed TypeSpec to entity fields
// ---------------------------------------------------------------------------

export interface ApplyTypeSpecResult {
  added: number;
  updated: number;
  removed: string[];
  error?: string;
}

type TypeSpecParsedField = {
  name: string;
  type: string;
  isOptional: boolean;
  isKey: boolean;
  decorators: Record<string, unknown>;
  arrayElementType?: string;
  /** Real-compiler reader: the type is `T | null` (see `SyncSourceField`). */
  nullableType?: boolean;
  /** Real-compiler reader: the members (and declared name) of a union type (see `SyncSourceField`). */
  unionName?: string;
  unionMembers?: string[];
};

export async function applyTypeSpecAction(
  entityId: string,
  parsedFields: Array<TypeSpecParsedField>,
  fieldsToRemove?: string[],
  /** Keyed by field name — semantic governance decorator values, from the real-compiler path (compileAndApplyTypeSpecSourceAction). Absent for the regex-parser path. */
  fieldGovernance?: Record<string, FieldGovernanceInfo>
): Promise<ApplyTypeSpecResult> {
  return applyTypeSpecFields(entityId, parsedFields, fieldsToRemove, fieldGovernance);
}

/**
 * `applyTypeSpecAction` plus what only the source compile knows and a client must not supply: the enums the source declares (the
 * compiler names an enum-typed field by its enum, which the merge reads back as an enum field).
 */
async function applyTypeSpecFields(
  entityId: string,
  parsedFields: Array<TypeSpecParsedField>,
  fieldsToRemove?: string[],
  fieldGovernance?: Record<string, FieldGovernanceInfo>,
  enums?: ReadonlyMap<string, readonly string[]>,
  /**
   * Field name -> the entity of the tenant the source's type name for it resolved to. Server-made only (`compileAndApplyTypeSpecSource`);
   * this function is not exported, so a client cannot hand it one: `applyTypeSpecAction` never passes any.
   */
  references?: ReadonlyMap<string, SourceReference>,
  /** The names the source declares (models, enums, scalars, unions): what a union field's members may name besides the scalars. */
  declared?: ReadonlySet<string>,
): Promise<ApplyTypeSpecResult> {

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing. Checked before the first
    // read: the field list below is the foreign entity's.
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { added: 0, updated: 0, removed: [], error: access.refusal.error };
    if (!Array.isArray(parsedFields)) return { added: 0, updated: 0, removed: [], error: "The parsed fields must be a list" };

    // Get existing fields for this entity
    const existingFields = await prisma.field.findMany({
      where: { entityId },
      orderBy: { sortOrder: "asc" },
    });

    const existingByName = new Map(existingFields.map((f) => [f.name, f]));

    // The model's NEW fields become field rows: one named like a key the AsyncAPI parser cannot read is refused before anything is
    // written (a field that already exists is left as it is, so a source with an old such field can still be saved).
    for (const pf of parsedFields) {
      const reserved = existingByName.has(pf.name) ? null : reservedFieldNameMessage(pf.name);
      if (reserved !== null) return { added: 0, updated: 0, removed: [], error: reserved };
    }

    let addedCount = 0;
    let updatedCount = 0;
    const removedNames: string[] = [];

    // Get max sort order for new fields
    const maxSort = existingFields.reduce((max, f) => Math.max(max, f.sortOrder), -1);
    let nextSort = maxSort + 1;

    // Get max field number for new fields
    const maxFieldNum = existingFields.reduce(
      (max, f) => Math.max(max, f.fieldNumber ?? 0),
      0
    );
    let nextFieldNum = maxFieldNum + 1;

    for (const pf of parsedFields) {
      const existing = existingByName.get(pf.name);
      const governance = fieldGovernance?.[pf.name];

      // The row the source means: the stored decorators MERGED with what the text can express (never replaced), see
      // `@/lib/typespec-sync/merge-fields` for which keys the source owns and which are preserved. `fieldGovernance` is only
      // given on the real-compiler path; a field without governance decorators there is still "known to have none".
      const merged = mergeSyncedField(existing ?? null, pf, {
        governance,
        governanceKnown: fieldGovernance !== undefined,
        enums,
        reference: references?.get(pf.name),
        declared,
      });
      const decoratorsJson = merged.decorators;
      const classification = merged.classification;

      if (!existing) {
        // Create new field
        await withAudit({
          action: "CREATE",
          entityType: "Field",
          entityId: "pending",
          userId: access.principal.userId,
          tenantId: access.resource.tenantId,
          fn: () =>
            prisma.field.create({
              data: {
                entityId,
                name: pf.name,
                slug: generateSlug(pf.name),
                type: merged.type,
                sortOrder: nextSort++,
                nullable: merged.nullable,
                isKey: pf.isKey,
                fieldNumber: nextFieldNum++,
                description: (pf.decorators.doc as string) ?? "",
                classification,
                decorators: decoratorsJson as Prisma.InputJsonValue,
              },
            }),
        });
        addedCount++;
      } else {
        // Anything changed? (A re-sync of unchanged source changes nothing.)
        if (fieldNeedsUpdate(existing, merged, pf)) {
          await withAudit({
            action: "UPDATE",
            entityType: "Field",
            entityId: existing.id,
            userId: access.principal.userId,
            tenantId: access.resource.tenantId,
            beforeState: existing as unknown as object,
            fn: () =>
              prisma.field.update({
                where: { id: existing.id },
                data: {
                  type: merged.type,
                  nullable: merged.nullable,
                  isKey: pf.isKey,
                  description: merged.description,
                  classification,
                  decorators: decoratorsJson as Prisma.InputJsonValue,
                  // The precision and scale live in the row, not in the text: a field that stops being a decimal takes them with it
                  // (a save that keeps it a decimal leaves them as they are).
                  ...(isDecimalType(existing.type) && !isDecimalType(merged.type) ? { precision: null, scale: null } : {}),
                },
              }),
          });
          updatedCount++;
        }
      }
    }

    // Handle field removal (only if explicitly requested)
    if (fieldsToRemove && fieldsToRemove.length > 0) {
      for (const fieldName of fieldsToRemove) {
        const existing = existingByName.get(fieldName);
        if (existing) {
          await withAudit({
            action: "DELETE",
            entityType: "Field",
            entityId: existing.id,
            userId: access.principal.userId,
            tenantId: access.resource.tenantId,
            beforeState: existing as unknown as object,
            fn: async () => {
              await prisma.field.delete({ where: { id: existing.id } });
              return null;
            },
          });
          removedNames.push(fieldName);
        }
      }
    }

    if (addedCount + updatedCount + removedNames.length > 0) {
      await markEntityDraftChanged(prisma, entityId);
    }

    revalidatePath("/schemas");
    return { added: addedCount, updated: updatedCount, removed: removedNames };
  } catch (e: unknown) {
    return { added: 0, updated: 0, removed: [], error: unexpectedFailure("applyTypeSpecAction", e).error };
  }
}

// ---------------------------------------------------------------------------
// Schema version management (stored in entity metadata JSONB)
// ---------------------------------------------------------------------------

async function getSchemaTargetFieldMappingsInternal(
  entityId: string,
  target: string,
  ctx: ServiceContext
) {
  // Every caller has authorized the entity BEFORE it gets here (it is in the active tenant and the caller's role covers it): this only reads.
  const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { id: true, metadata: true } });
  if (!entity) return { error: "Entity not found" as const };

  const fieldRows = await prisma.field.findMany({
    where: { entityId },
    orderBy: { sortOrder: "asc" },
  });

  const policyOverrideResult = await getOverridesForEntity(entityId, ctx);
  const policyOverrides = policyOverrideResult.success
    ? policyOverrideResult.data
    : [];

  const parsedOverrides = parseSchemaTargetTypeOverrides(
    (entity.metadata as Record<string, unknown> | null)?.schemaTargetTypeOverrides
  );
  const fieldPolicies = toFieldOverridePolicies(parsedOverrides, target);
  const mappings = buildSchemaTargetFieldMappings(
    fieldRows.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      precision: field.precision,
      scale: field.scale,
      nullable: field.nullable,
      isKey: field.isKey,
      fieldNumber: field.fieldNumber,
      description: field.description,
      classification: field.classification,
      aliases: field.aliases,
      decorators: field.decorators,
      sortOrder: field.sortOrder,
    })),
    target,
    [...policyOverrides, ...fieldPolicies],
    parsedOverrides,
    entityId
  );

  return {
    entity,
    fieldRows,
    parsedOverrides,
    mappings,
  };
}

/**
 * Get all schema versions per target from entity metadata.
 */
export async function getSchemaVersionsAction(entityId: string) {

  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { ...notFoundFailure("Entity") };

    // The stored versions carry the generated files of every entity of the closure they were made from (a wider role may have made them): the reader
    // gets the copy their own roles cover (KD-046), the stored value stays whole for the writers.
    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = await redactSchemaVersions(prisma, meta.schemaVersions ?? {}, {
      root: { entityId, place: { tenantId: access.resource.tenantId, domainId: access.resource.domainId ?? null, productId: access.resource.productId ?? null } },
      assignments: access.principal.assignments,
    });
    return { success: true, schemaVersions };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getSchemaVersionsAction", e) };
  }
}

export async function getSchemaTargetFieldMappingsAction(
  entityId: string,
  target: string
) {

  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const targetDefinition = getSchemaTargetDefinition(target);
    const targetCatalog = getTargetTypeCatalogEntry(target);
    if (!targetDefinition) {
      return { error: `Unknown schema target "${target}"` };
    }

    if (!targetDefinition.supportsFieldOverrides) {
      return {
        success: true,
        supported: false,
        reason:
          "This target is generated by the external TypeSpec CLI path and does not yet support per-field physical type overrides.",
        mappings: [],
        typeCatalog: targetCatalog ?? null,
      };
    }

    // The entity (and its tenant) is checked inside: a foreign entity gets the same "Entity not found" as a missing one.
    const result = await getSchemaTargetFieldMappingsInternal(
      entityId,
      target,
      contextOf(access.principal)
    );
    if ("error" in result) {
      return { error: result.error };
    }

    return {
      success: true,
      supported: true,
      mappings: result.mappings,
      typeCatalog: targetCatalog ?? null,
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getSchemaTargetFieldMappingsAction", e) };
  }
}

export async function saveSchemaFieldTypeOverrideAction(input: {
  entityId: string;
  target: string;
  fieldId: string;
  mappedType: string;
}) {

  if (!isPlainObject(input)) return { error: "The override details are required", code: "VALIDATION_ERROR" };

  try {
    const access = await guardSubject("typemapping.entity", { kind: "entity", id: input.entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const targetDefinition = getSchemaTargetDefinition(input.target);
    if (!targetDefinition) {
      return { error: `Unknown schema target "${input.target}"` };
    }

    if (!targetDefinition.supportsFieldOverrides) {
      return {
        error:
          "This target is generated by the external TypeSpec CLI path and does not support per-field physical type overrides.",
      };
    }

    const targetCatalog = getTargetTypeCatalogEntry(input.target);
    if (!targetCatalog) {
      return { error: `No type catalog found for schema target "${input.target}"` };
    }

    // The entity (and its tenant) is checked inside: a foreign entity gets the same "Entity not found" as a missing one,
    // and nothing below it runs (no override write, no regeneration).
    const result = await getSchemaTargetFieldMappingsInternal(
      input.entityId,
      input.target,
      contextOf(access.principal)
    );
    if ("error" in result) {
      return { error: result.error };
    }

    const field = result.fieldRows.find((row) => row.id === input.fieldId);
    if (!field) {
      return { error: "Field not found" };
    }

    const mapping = result.mappings.find((row) => row.fieldId === input.fieldId);
    if (!mapping) {
      return { error: "Target mapping row not found" };
    }

    const removesOverride = !input.mappedType || input.mappedType === mapping.defaultMappedType;
    const validMappedType = targetCatalog.options.some((option) => option.value === input.mappedType);
    if (!removesOverride && !validMappedType) {
      return { error: `Invalid ${targetCatalog.displayName} target type "${input.mappedType}"` };
    }


    const nextOverrides: SchemaTargetTypeOverrides =
      removesOverride
        ? removeFieldTargetTypeOverride(
            result.parsedOverrides,
            input.target,
            input.fieldId
          )
        : upsertFieldTargetTypeOverride(result.parsedOverrides, {
            target: input.target,
            fieldId: input.fieldId,
            fieldName: field.name,
            sourceType: field.type,
            mappedType: input.mappedType,
            defaultMappedType: mapping.defaultMappedType,
            userId: access.principal.userId,
          });

    const existingMeta = (result.entity.metadata as Record<string, unknown>) ?? {};
    const updatedMeta = {
      ...existingMeta,
      schemaTargetTypeOverrides: nextOverrides,
    };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId: input.entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { metadata: existingMeta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: input.entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    const generation = await generateSchemaAction(input.entityId, input.target);
    if (generation.error) {
      return { error: generation.error };
    }

    revalidatePath("/schemas");
    return {
      success: true,
      schemaVersion: generation.schemaVersion,
      // the regeneration's warnings (already plain, bounded strings), so the caller can show them
      warnings: generation.warnings,
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("saveSchemaFieldTypeOverrideAction", e) };
  }
}

/** At most this many warnings, each cut to this many characters, go to the client (a target result can carry many). */
const MAX_WARNINGS_TO_CLIENT = 20;
const MAX_WARNING_LENGTH = 300;

/** A target result's warnings (strings; objects with a `message` from the older native path) as bounded, non-empty strings. */
function warningMessages(warnings: readonly unknown[]): string[] {
  return warnings
    .map((warning) => (typeof warning === "string" ? warning : String((warning as { message?: unknown } | null)?.message ?? "")))
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .slice(0, MAX_WARNINGS_TO_CLIENT)
    .map((text) => (text.length > MAX_WARNING_LENGTH ? `${text.slice(0, MAX_WARNING_LENGTH - 1).trimEnd()}…` : text));
}

/** The fields of an entity as the requirement checks read them (declaration order); null when the entity is gone. */
async function loadRequirementShape(entityId: string): Promise<RequirementEntityShape | null> {
  const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { name: true } });
  if (!entity) return null;
  const fields = await prisma.field.findMany({
    where: { entityId },
    select: { name: true, isKey: true, nullable: true, type: true, decorators: true },
    orderBy: { sortOrder: "asc" },
  });
  return {
    name: entity.name,
    fields: fields.map(({ decorators, ...field }) => ({ ...field, dangling: activeDanglingRef(field.type, decorators as Record<string, unknown> | null) !== undefined })),
  };
}

/**
 * What `target` still needs from the user before it can be generated for this entity (today: a primary key for BigQuery,
 * PostgreSQL and Spanner). `{ needsInput: [] }` means generation can go ahead. Never emits anything.
 */
export async function getSchemaGenerationRequirementsAction(
  entityId: string,
  target: string,
): Promise<{ needsInput: MissingRequirement[] } | { error: string; code?: string }> {
  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    if (!getSchemaTargetDefinition(target)) return { error: `Unknown schema target "${target}"` };
    if (!hasTargetRequirements(target)) return { needsInput: [] };
    const shape = await loadRequirementShape(entityId);
    if (!shape) return { ...notFoundFailure("Entity") };
    return { needsInput: getTargetRequirements(target, shape).missing };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getSchemaGenerationRequirementsAction", e) };
  }
}

const MAX_PRIMARY_KEY_FIELDS = 16;

/**
 * Save the user's answer to a "needs a primary key" question: exactly the named fields of this entity get `isKey = true`, every
 * other field `isKey = false` (one transaction, with the draft mark every field edit makes). The answer applies to every target.
 */
export async function setEntityPrimaryKeyAction(entityId: string, fieldNames: string[]) {

  if (!Array.isArray(fieldNames) || fieldNames.length === 0) {
    return { error: "Choose at least one field for the primary key", code: "VALIDATION_ERROR" as const };
  }
  if (fieldNames.length > MAX_PRIMARY_KEY_FIELDS) {
    return { error: `A primary key has at most ${MAX_PRIMARY_KEY_FIELDS} fields`, code: "VALIDATION_ERROR" as const };
  }
  if (fieldNames.some((name) => typeof name !== "string" || name === "")) {
    return { error: "Field names must be non-empty text", code: "VALIDATION_ERROR" as const };
  }
  if (new Set(fieldNames).size !== fieldNames.length) {
    return { error: "A field can only be listed once", code: "VALIDATION_ERROR" as const };
  }

  try {
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const existing = await prisma.field.findMany({
      where: { entityId },
      select: { id: true, name: true, isKey: true, type: true, decorators: true },
    });
    const known = new Set(existing.map((field) => field.name));
    const unknown = fieldNames.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      return { error: `Not a field of this entity: ${unknown.slice(0, 3).join(", ")}`, code: "VALIDATION_ERROR" as const };
    }
    // The same rule the dialog's candidate list uses: a collection, JSON, union or unresolved reference cannot identify a row.
    for (const name of fieldNames) {
      const field = existing.find((candidate) => candidate.name === name);
      const reason = field ? primaryKeyIneligibility({ name, type: field.type, dangling: activeDanglingRef(field.type, field.decorators as Record<string, unknown> | null) !== undefined }) : null;
      if (reason) return { error: reason, code: "VALIDATION_ERROR" as const };
    }

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { primaryKey: existing.filter((field) => field.isKey).map((field) => field.name) } as unknown as object,
      fn: async () => {
        await prisma.$transaction([
          // A key is never null: left optional it makes JSON Schema / OpenAPI / Avro / Protobuf / Java refuse the entity (`no-optional-key`).
          prisma.field.updateMany({ where: { entityId, name: { in: fieldNames } }, data: { isKey: true, nullable: false } }),
          prisma.field.updateMany({ where: { entityId, name: { notIn: fieldNames } }, data: { isKey: false } }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
        ]);
        // The state the entry records is the key it leaves (the transaction's row counts are not a state of the entity).
        return { primaryKey: fieldNames };
      },
    });

    revalidatePath("/schemas");
    return { success: true as const, primaryKey: [...fieldNames] };
  } catch (e: unknown) {
    return { ...unexpectedFailure("setEntityPrimaryKeyAction", e) };
  }
}

/**
 * The explicit pick action: points a reference field at one entity, storing the fully qualified reference
 * (`domain/product/entity` + `referencedEntityId`). No version is stored unless `pinnedVersion` is given, and a pin must
 * name a PUBLISHED version of the target (`null` / omitted clears any earlier pin). Source entity, field and target must all
 * be in the active tenant.
 */
export async function setFieldReferenceAction(
  entityId: string,
  fieldId: string,
  ref: { entityId: string; pinnedVersion?: string | null }
): Promise<Result<void, ServiceError>> {
  const notFound = (kind: string) => err({ code: "NOT_FOUND", message: `${kind} not found` });
  try {
    for (const [value, label] of [[entityId, "Entity id"], [fieldId, "Field id"], [ref?.entityId, "Referenced entity id"]] as const) {
      const id = requireId(value, label);
      if (!id.success) return id;
    }
    // Re-pointing a reference is an edit of the entity (entity.write over ITS place): the entity must be in the active tenant and the caller's
    // role must cover it (a viewer is refused, a domain-scoped author only inside their domain), before anything is read.
    const access = await authorizeSubject("entity.write", { kind: "entity", id: entityId }, { code: "NOT_FOUND", message: "Entity not found" });
    if (!access.success) return err(access.error);
    // The target is an entity the caller can see in the active tenant (a pick must not reach into a domain their role does not cover).
    if (!ref || typeof ref.entityId !== "string" || !(await readableEntity(ref.entityId))) return notFound("Referenced entity");

    const field = await prisma.field.findUnique({
      where: { id: fieldId },
      select: { id: true, entityId: true, type: true, decorators: true },
    });
    if (!field || field.entityId !== entityId) return notFound("Field");
    // A reference field, or an array / map of references (the same keys, stored on the field's decorators): the ambiguity of such a field
    // is asked about too (`needsReference`), so its pick must be writable.
    if (!holdsEntityReference(field.type, field.decorators)) {
      return err({ code: "VALIDATION_ERROR", message: "Only a reference field (or an array or map of references) can point at an entity" });
    }

    const target = await prisma.entity.findUnique({
      where: { id: ref.entityId },
      select: { id: true, name: true, domain: { select: { name: true } }, product: { select: { name: true } } },
    });
    if (!target) return notFound("Referenced entity");

    let pinnedVersion: string | undefined;
    if (ref.pinnedVersion !== undefined && ref.pinnedVersion !== null) {
      const parsed = parseVersionLabel(ref.pinnedVersion);
      if (!parsed.success) return err({ code: "VALIDATION_ERROR", message: `"${ref.pinnedVersion}" is not a published version label` });
      // Every EntityVersion row is a published version; a draft has no row, so it cannot be pinned.
      const published = await prisma.entityVersion.findUnique({
        where: { entityId_major_minor: { entityId: target.id, major: parsed.data.major, minor: parsed.data.minor } },
      });
      if (!published) {
        return err({ code: "VALIDATION_ERROR", message: `${target.name} has no published version ${formatVersionLabel(parsed.data)}` });
      }
      pinnedVersion = formatVersionLabel(parsed.data);
    }

    const current = field.decorators && typeof field.decorators === "object" && !Array.isArray(field.decorators)
      ? (field.decorators as Record<string, unknown>)
      : {};
    const decorators = writeFieldReference(current, {
      entityId: target.id,
      domain: target.domain?.name ?? TENANT_PLACEHOLDER,
      product: target.product?.name ?? TENANT_PLACEHOLDER,
      entity: target.name,
      ...(pinnedVersion ? { pinnedVersion } : {}),
    });

    await withAudit({
      action: "UPDATE",
      entityType: "Field",
      entityId: fieldId,
      userId: access.data.principal.userId,
      beforeState: field as unknown as object,
      fn: () =>
        prisma.$transaction([
          prisma.field.update({ where: { id: fieldId }, data: { decorators: decorators as Prisma.InputJsonValue } }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
        ]),
    });

    revalidatePath("/schemas");
    return ok(undefined);
  } catch (e: unknown) {
    const failure = unexpectedFailure("setFieldReferenceAction", e);
    return err({ code: failure.code, message: failure.error });
  }
}

/**
 * Generate a schema for ONE target, store as draft version in entity metadata. When the target needs an input the entity does
 * not carry (a primary key), nothing is emitted and the answer is `{ needsInput: [...] }` for the UI to ask.
 *
 * The closure targets (JSON Schema, OpenAPI 3, Protobuf, Avro, Java POJO) generate the entity TOGETHER WITH everything it references
 * (`loadReferenceClosure` + `emitClosure`): one file per entity, stored as `files` (and `output` as their bundled string) with a
 * `resolution` recording which version of each entity was used. `opts.mode` decides what an unpinned reference resolves to: `draft`
 * (the default: this is the entity's current saved state) the latest saved definition, the version is then a preview; `published`
 * (the publish flow, regeneration of a published version) the latest PUBLISHED version of each entity, never a draft, the ENTITY ITSELF
 * included: it is read from its latest published version too, so unpublished edits to it are not in the result. A pin overrides
 * both. A bare-name reference that matches several entities is not guessed: nothing is emitted or written and the answer is
 * `{ needsReference: { field, name, candidates, entityId, fieldId } }` for the UI to ask (`setFieldReferenceAction` saves the pick).
 * The DB targets (and the native runtime) keep their own path, one entity, and ignore `mode`.
 *
 * Emission itself writes nothing. When it succeeded, the ROOT's legacy name-only references that resolved to exactly one entity are
 * upgraded to the qualified form in a separate step that fails soft (see `upgradeLegacyReferences`).
 */
export async function generateSchemaAction(entityId: string, target: string, opts?: { mode?: ResolveMode }) {

  const requestedMode: unknown = opts?.mode;
  if (requestedMode !== undefined && requestedMode !== "draft" && requestedMode !== "published") {
    return { error: 'The mode must be "draft" or "published"', code: "VALIDATION_ERROR" as const };
  }
  const mode: ResolveMode = requestedMode ?? "draft";

  try {
    // Ownership FIRST: both emitters read the entity by id and trust it, so a foreign id must stop here.
    const access = await guardSubject("schema.generate", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const targetDefinition = getSchemaTargetDefinition(target);
    if (!targetDefinition) {
      return { error: `Unknown schema target "${target}"` };
    }

    // Ask for what the target needs BEFORE emitting (the emitter would only fail with a diagnostic).
    let requirementShape: RequirementEntityShape | null = null;
    if (hasTargetRequirements(target)) {
      requirementShape = await loadRequirementShape(entityId);
      if (!requirementShape) return { ...notFoundFailure("Entity") };
      const { missing } = getTargetRequirements(target, requirementShape);
      if (missing.length > 0) return { needsInput: missing };
    }

    let targetOutput: {
      output: string;
      validationStatus: string;
      warnings: unknown[];
      errors: unknown[];
    };
    // Set by the closure targets only: the structured files, the versions used and the legacy references that resolved.
    let closureRun: { files?: EmittedFile[]; resolution: SchemaVersionResolution; upgrades: LegacyUpgrade[] } | undefined;

    if (targetDefinition.runtime === "native") {
      const { emitEntity } = await import("@/lib/emission/emission.service");
      const result = await emitEntity(entityId, entityReader(access.principal.assignments));
      const nativeTargetOutput = result.targets[target];
      if (!nativeTargetOutput) {
        return { error: `No output found for target "${target}"` };
      }
      targetOutput = nativeTargetOutput;
    } else {
      let officialResult: ClosureTargetResult;
      if (targetDefinition.closureEmission) {
        // The root passed the tenant check above, so its closure is confined to that same (active) tenant, and to what the caller's roles cover: an
        // entity it references that they may not read refuses the generation (REFERENCE_NOT_READABLE) before anything is built from it (KD-045).
        // In published mode the ROOT too is read from its latest PUBLISHED version, not from its saved rows: unpublished edits to the
        // entity itself are not in the result (publish the entity first to include them), exactly like its referenced entities.
        const { closureFailure, describeResolution, emitClosureTarget } = await import("@/lib/emission/closure-generation");
        const loaded = await loadReferenceClosure(prisma, await getActiveTenantId(), entityId, mode, { reader: entityReader(access.principal.assignments) });
        if (!loaded.success) {
          // A name frozen in a published or pinned member is not a question (a pick cannot change a published version): it is the refusal.
          if (loaded.error.code === "AMBIGUOUS_REFERENCE" && !loaded.error.frozen) {
            const { field, name, candidates, entityId: ownerEntityId, fieldId } = loaded.error;
            return { needsReference: { field, name, candidates, entityId: ownerEntityId, fieldId } };
          }
          return { ...failureOf(closureFailure(loaded.error), "generateSchemaAction") };
        }
        officialResult = await emitClosureTarget(loaded.data, targetDefinition.key);
        closureRun = { files: officialResult.files, resolution: describeResolution(loaded.data, mode), upgrades: loaded.data.upgrades };
      } else {
        const { emitOfficialTypeSpecTargetForEntity } = await import(
          "@/lib/typespec-official/emitter.service"
        );
        officialResult = await emitOfficialTypeSpecTargetForEntity(entityId, target, { tenantId: await getActiveTenantId(), mode, reader: entityReader(access.principal.assignments) });
      }
      if (officialResult.validationStatus === "INVALID") {
        // A diagnostic that means "an input is missing" slipped past the pre-check: still a question, not an error string.
        const slipped = officialResult.errors.flatMap((error) => structuredDiagnostics(error.message));
        if (slipped.length > 0) {
          const shape = requirementShape ?? (await loadRequirementShape(entityId));
          const asked = shape
            ? slipped.map((diagnostic) => requirementFromDiagnostic(diagnostic, shape)).filter((r): r is MissingRequirement => r !== null)
            : [];
          if (asked.length > 0) return { needsInput: asked };
        }
        const firstError = officialResult.errors[0]?.message;
        // The generation failed (not a question, not a refusal to resolve a reference): the Health card "Emission Failures" counts it.
        await recordAuditFailure({
          action: "EMISSION_FAILED",
          entityType: "Entity",
          entityId,
          userId: access.principal.userId,
          tenantId: access.resource.tenantId,
          details: { target, mode, message: (firstError ?? "").slice(0, 500) },
        });
        return { error: firstError ?? `Failed to generate ${targetDefinition.displayName}` };
      }
      targetOutput = officialResult;
    }

    // Load entity to get current metadata, version, and fields for type mapping
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true, version: true, fields: { select: { id: true, name: true, type: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (!entity) return { error: "Entity not found" };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};

    const parsedOverrides = parseSchemaTargetTypeOverrides(
      meta.schemaTargetTypeOverrides
    );
    let fieldTypeMappings: FieldTypeMapping[] = [];
    let typeOverrideSnapshot: FieldTargetTypeOverride[] | undefined;
    let staleOverrideCount = 0;
    if (targetDefinition.supportsFieldOverrides) {
      const mappingContext = await getSchemaTargetFieldMappingsInternal(
        entityId,
        target,
        contextOf(access.principal)
      );
      if (!("error" in mappingContext)) {
        fieldTypeMappings = mappingContext.mappings.map((row) => ({
          fieldName: row.fieldName,
          sourceType: row.sourceType,
          targetType: row.effectiveMappedType,
        }));
        typeOverrideSnapshot = Object.values(parsedOverrides[target] ?? {});
        staleOverrideCount = mappingContext.mappings.filter((row) => row.isStale).length;
      }
    }

    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targetVersions = schemaVersions[target] ?? [];

    // If latest version is draft, update it in-place; otherwise create new version
    const latestVersion = targetVersions[0];
    const isLatestDraft = latestVersion?.status === "draft";

    const maxVersion = targetVersions.reduce(
      (max, v) => Math.max(max, v.version),
      0
    );

    const versionNumber = isLatestDraft ? latestVersion.version : maxVersion + 1;

    const newVersion: SchemaVersion = {
      version: versionNumber,
      status: "draft",
      output: targetOutput.output,
      generatedAt: new Date().toISOString(),
      entityVersion: entity.version,
      ...(closureRun?.files ? { files: closureRun.files, resolution: closureRun.resolution } : {}),
      fieldTypeMappings,
      typeOverrideSnapshot,
      overrideDriftSummary: typeOverrideSnapshot
        ? {
            activeCount: typeOverrideSnapshot.length,
            staleCount: staleOverrideCount,
          }
        : undefined,
    };

    // If updating draft in-place, replace it; otherwise prepend new version
    const updatedVersions = isLatestDraft
      ? [newVersion, ...targetVersions.slice(1)]
      : [newVersion, ...targetVersions];
    const updatedMeta = {
      ...meta,
      schemaVersions: { ...schemaVersions, [target]: updatedVersions },
    };

    // A generation is audited as GENERATE (not UPDATE): the Health cards count it as an emission and not as a change of the schema.
    await withAudit({
      action: "GENERATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { metadata: meta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    // Generation is done and stored; qualifying the references it resolved is a separate step that never fails it.
    if (closureRun) await upgradeLegacyReferences(entityId, access.principal, access.resource, closureRun.upgrades);

    revalidatePath("/schemas");
    return {
      success: true,
      schemaVersion: newVersion,
      validationStatus: targetOutput.validationStatus,
      warnings: warningMessages(targetOutput.warnings),
      errors: targetOutput.errors,
    };
  } catch (e: unknown) {
    return { ...unexpectedFailure("generateSchemaAction", e) };
  }
}

/**
 * After a successful closure generation: writes the qualified form (`referencedEntityId` + `referencedQualifiedName`, never a version)
 * of the ROOT entity's legacy name-only references that resolved to exactly one entity (`upgradeLegacyReference`), so a later
 * same-named entity cannot make them ambiguous. Deliberately narrow and quiet:
 * - only the root's own fields (a generate call does not edit other entities), and never content read from a published or pinned
 *   snapshot (the loader lists none of those);
 * - the edit role `setFieldReferenceAction` requires: a viewer's generation stays read-only;
 * - each field is re-read first and skipped unless it is still a legacy reference (a pick made meanwhile wins);
 * - not a draft edit (the reference means the same thing): the draft marker and the stale-source marker are left alone;
 * - fails soft per field: the generation is already stored, so a failure here is logged and nothing more.
 */
async function upgradeLegacyReferences(entityId: string, principal: Principal, resource: ResourceRef, upgrades: LegacyUpgrade[]): Promise<void> {
  const own = upgrades.filter((upgrade) => upgrade.entityId === entityId);
  if (own.length === 0) return;
  // The same decision `setFieldReferenceAction` asks (an edit of this entity), taken from the principal that was just authorized to generate.
  if (!can(principal.assignments, "entity.write", resource)) return;
  const userId = principal.userId;
  for (const upgrade of own) {
    try {
      const field = await prisma.field.findUnique({ where: { id: upgrade.fieldId }, select: { id: true, entityId: true, type: true, decorators: true } });
      if (!field || field.entityId !== entityId || field.type !== "reference") continue;
      if (!field.decorators || typeof field.decorators !== "object" || Array.isArray(field.decorators)) continue;
      const current = field.decorators as Record<string, unknown>;
      const existing = readFieldReference(current);
      if (!existing || !("legacyName" in existing)) continue;
      const decorators = upgradeLegacyReference(current, upgrade.ref);
      await withAudit({
        action: "UPDATE",
        entityType: "Field",
        entityId: field.id,
        userId,
        beforeState: field as unknown as object,
        fn: () => prisma.field.update({ where: { id: field.id }, data: { decorators: decorators as Prisma.InputJsonValue } }),
      });
    } catch (e: unknown) {
      console.error(`[generateSchemaAction] legacy reference upgrade failed (entity ${upgrade.entityId}, field ${upgrade.fieldId})`, e);
    }
  }
}

/**
 * Publish a schema version (draft -> published).
 *
 * A stored version that resolved a REFERENCED entity at draft state (`draftReferencedEntities`: a version generated from the entity
 * page is a preview of the saved draft of what it references) is refused: a published schema never contains draft content of a
 * referenced entity. The refusal names those entities, says to publish any that are not yet published and then regenerate from the
 * published versions, and carries `needsPublishedRegeneration` + `draftEntities` for the UI. A version regenerated in published mode,
 * a stand-alone one (no references) and a DB / native one (no `resolution`) publish exactly as before.
 *
 * `opts.regenerateFromPublished === true` is the one-step way out of that refusal: the target is regenerated in published mode
 * (`generateSchemaAction(..., { mode: "published" })`, which refuses naming any referenced entity that was never published or any pin
 * that is gone) and the REGENERATED version is published, never the preview. It does nothing when the version is publishable as it is.
 * Published mode reads the ENTITY ITSELF from its latest published version too, so the regenerated version does not include unpublished
 * edits to the entity (the refusal says so). An ambiguous bare-name reference met while regenerating is answered with `needsReference`
 * (the shape `generateSchemaAction` answers) beside the error, so the UI can ask for the pick.
 */
export async function publishSchemaAction(
  entityId: string,
  target: string,
  version: number,
  opts?: { regenerateFromPublished?: boolean }
) {

  try {
    const access = await guardSubject("entity.publish", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    // At most two rounds: the second only runs after a regeneration from the published versions and publishes what that produced.
    let publishing = version;
    let regenerated = false;
    for (;;) {
      const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
      if (!entity) return { ...notFoundFailure("Entity") };

      const meta = (entity.metadata as Record<string, unknown>) ?? {};
      const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
      const targetVersions = schemaVersions[target];
      if (!targetVersions) return { error: `No versions found for target "${target}"` };

      const idx = targetVersions.findIndex((v) => v.version === publishing);
      if (idx === -1) return { error: `Version ${publishing} not found` };
      // A second submit of the same Publish (a double click, a retry after a slow answer) finds the version already published: that is the
      // answer the first submit got, not an error. A version number is immutable (a regeneration makes a new one), so "published" is
      // the very content that was asked to be published. Nothing is written.
      const stored = targetVersions[idx].status;
      if (stored === "published" || stored === "deployed") {
        return {
          success: true as const,
          alreadyPublished: true as const,
          version: publishing,
          status: stored,
          message: stored === "deployed" ? `Version ${publishing} is already published (it is deployed).` : `Version ${publishing} is already published.`,
        };
      }
      if (stored !== "draft") {
        return { error: `Version ${publishing} is not a draft (current: ${stored})` };
      }

      // A preview that used the saved draft of a referenced entity cannot be published as it is.
      const draftReferences = draftReferencedEntities(targetVersions[idx].resolution, entityId);
      if (draftReferences.length > 0) {
        // (A version regenerated in published mode has no draft reference; `regenerated` only stops a loop that cannot happen.)
        if (regenerated || opts?.regenerateFromPublished !== true) {
          return {
            error: draftReferenceRefusal(draftReferences),
            code: "PREVIEW_NOT_PUBLISHABLE",
            needsPublishedRegeneration: true,
            draftEntities: draftReferences,
          };
        }
        const result = await generateSchemaAction(entityId, target, { mode: "published" });
        if ("error" in result && result.error) return { error: result.error, ...("code" in result && result.code ? { code: result.code } : {}) };
        if ("needsInput" in result && result.needsInput) {
          return { error: result.needsInput[0]?.message ?? "Regenerating from the published versions needs more input", code: "VALIDATION_ERROR" };
        }
        // A published-mode closure reads every entity from a frozen snapshot, so its ambiguity is a refusal (`error`, handled above), never a
        // pick; this stays as the total answer for a generation that does ask for one.
        if ("needsReference" in result && result.needsReference) {
          const { field, name, candidates } = result.needsReference;
          return {
            error: `Field "${field}" refers to "${name}", which matches ${candidates.length} entities. Choose the entity it means on that field, then publish again.`,
            code: "AMBIGUOUS_REFERENCE",
            // The pick to ask for: where it is written (entityId + fieldId, a member as often as this entity) and what it chooses from.
            needsReference: result.needsReference,
          };
        }
        if (!("schemaVersion" in result) || !result.schemaVersion) return { error: "Regenerating from the published versions failed" };
        publishing = result.schemaVersion.version;
        regenerated = true;
        continue;
      }

      // Publishing changes only the version it publishes. A deployed version stays deployed until another version is deployed in its place
      // (deploying un-deploys it), so the schema keeps recording which version is deployed. Which environment runs which version is the
      // deployment records' answer, and publishing leaves those alone too.
      const updated = targetVersions.map((v, i) =>
        i === idx ? { ...v, status: "published" as const, publishedAt: new Date().toISOString() } : v
      );

      const updatedMeta = {
        ...meta,
        schemaVersions: { ...schemaVersions, [target]: updated },
      };

      await withAudit({
        action: "UPDATE",
        entityType: "Entity",
        entityId,
        userId: access.principal.userId,
        tenantId: access.resource.tenantId,
        beforeState: { metadata: meta } as unknown as object,
        fn: () =>
          prisma.entity.update({
            where: { id: entityId },
            data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
          }),
      });

      revalidatePath("/schemas");
      return { success: true };
    }
  } catch (e: unknown) {
    return { ...unexpectedFailure("publishSchemaAction", e) };
  }
}

/**
 * Deploy a schema version (published -> deployed).
 */
export async function deploySchemaAction(
  entityId: string,
  target: string,
  version: number
) {

  try {
    const access = await guardSubject("deploy.run", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { ...notFoundFailure("Entity") };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targetVersions = schemaVersions[target];
    if (!targetVersions) return { error: `No versions found for target "${target}"` };

    const idx = targetVersions.findIndex((v) => v.version === version);
    if (idx === -1) return { error: `Version ${version} not found` };
    if (targetVersions[idx].status !== "published") {
      return { error: `Version ${version} is not published (current: ${targetVersions[idx].status})` };
    }

    // One deployed version at a time: deploying this one (a rollback to an older published version included) puts the version that was
    // deployed back to published, the identity it had before it was deployed.
    const updated = targetVersions.map((v, i) => {
      if (i === idx) return { ...v, status: "deployed" as const, deployedAt: new Date().toISOString() };
      return v.status === "deployed" ? { ...v, status: "published" as const } : v;
    });

    const updatedMeta = {
      ...meta,
      schemaVersions: { ...schemaVersions, [target]: updated },
    };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { metadata: meta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("deploySchemaAction", e) };
  }
}

/**
 * The `custom` a metadata write stores. The client's custom properties replace the stored ones, but the `extensions` the TypeSpec sync records
 * beside them (SET_ENTITY_EXTENSIONS_SQL) are kept as the row holds them, and an `extensions` the client sends is never stored. A `custom` sent
 * as null or as a non-object clears the properties and keeps the extensions.
 */
function customWithStoredExtensions(storedCustom: unknown, sentCustom: unknown): unknown {
  const storedExtensions = isPlainObject(storedCustom) ? (storedCustom as Record<string, unknown>).extensions : undefined;
  if (storedExtensions === undefined && !isPlainObject(sentCustom)) return sentCustom;
  const properties = isPlainObject(sentCustom)
    ? Object.fromEntries(Object.entries(sentCustom as Record<string, unknown>).filter(([key]) => key !== "extensions"))
    : {};
  return storedExtensions === undefined ? properties : { ...properties, extensions: storedExtensions };
}

/**
 * Update entity metadata (generic helper for schema version updates).
 */
export async function updateEntityMetadataAction(
  entityId: string,
  metadata: Record<string, unknown>
) {
  // The merge below spreads `metadata`: only a plain object is a metadata patch (a Date, Map or string spreads to nothing
  // or to characters and would still mark the draft changed).
  if (!isPlainObject(metadata)) return { error: "The metadata changes must be an object", code: "VALIDATION_ERROR" };

  // Which keys may be set, and by whom: bookkeeping is an edit (`entity.write`); the state of a release, of the lifecycle or of retention needs
  // the action that changes it (see METADATA_KEY_ACTIONS); a key that is not listed is the server's and is refused. Decided from the keys alone.
  const keys = Object.keys(metadata);
  const unknownKey = keys.find((key) => !Object.hasOwn(METADATA_KEY_ACTIONS, key));
  if (unknownKey !== undefined) return { error: `The metadata key "${unknownKey.slice(0, 64)}" cannot be changed here`, code: "VALIDATION_ERROR" };
  const required = [...new Set<ActionId>(["entity.write", ...keys.flatMap((key) => METADATA_KEY_ACTIONS[key])])];

  try {
    const access = await guardSubject(required[0], { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    // Every further action a key asks for is judged over the same place; one the caller lacks refuses the WHOLE patch (nothing is written).
    if (required.slice(1).some((action) => !can(access.principal.assignments, action, access.resource))) {
      return { error: "You do not have permission to do this", code: "FORBIDDEN" as const };
    }

    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { ...notFoundFailure("Entity") };

    const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: access.principal.userId,
      tenantId: access.resource.tenantId,
      beforeState: { metadata: existingMeta } as unknown as object,
      fn: () =>
        prisma.$transaction(async (tx) => {
          // The merge runs under the row lock (the one publish and delete take) over the metadata AS IT STANDS under it: the copy read above is
          // older than any write that landed since, and a whole-column write of that copy would revert it.
          await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${entityId} FOR UPDATE`;
          const locked = await tx.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
          const storedMeta = (locked?.metadata as Record<string, unknown>) ?? {};
          const sent = Object.hasOwn(metadata, "custom")
            ? { ...metadata, custom: customWithStoredExtensions(storedMeta.custom, metadata.custom) }
            : metadata;
          const mergedMeta = { ...storedMeta, ...sent };
          // A draft edit (tags, owner, retention, custom, ...) marks the stored TypeSpec source stale (R45);
          // bookkeeping-only edits leave it alone, but never let an already-stale source go fresh.
          const changesDraft = metadataChangesDraft(storedMeta, mergedMeta);
          const updatedMeta = withSourceStale(storedMeta, mergedMeta, changesDraft);
          return tx.entity.update({
            where: { id: entityId },
            data: {
              metadata: updatedMeta as unknown as Prisma.InputJsonValue,
              ...(changesDraft && { hasUnpublishedChanges: true }),
            },
          });
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateEntityMetadataAction", e) };
  }
}

export async function updateEntityDescriptionAction(
  entityId: string,
  description: string
) {

  if (typeof description !== "string") return { error: "The description must be text", code: "VALIDATION_ERROR" };

  try {
    // Ownership: the entity must belong to the active tenant; anything else reads as missing.
    const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    // The description is rendered into the TypeSpec source (@doc): the write and the draft + stale-source
    // mark are one atomic batch, so the description can never land without the mark (R45).
    await prisma.$transaction([
      prisma.entity.update({
        where: { id: entityId },
        data: { description },
      }),
      prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
    ]);

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("updateEntityDescriptionAction", e) };
  }
}


// ---------------------------------------------------------------------------
// Deployment tracking (per-environment) — powers the entity Deployments tab.
// Emission targets are derived from the entity's schemaVersions metadata; the
// deployment.service store tracks which version is live in each environment.
// ---------------------------------------------------------------------------

function buildEmissionTargets(
  entityId: string,
  schemaVersions: SchemaVersionsMap
): { id: string; targetFormat: string; emittedVersion: string | null; versions: SchemaVersion[] }[] {
  return Object.keys(schemaVersions)
    .filter((target) => (schemaVersions[target] ?? []).length > 0)
    .map((target) => {
      const versions = schemaVersions[target] ?? [];
      const latest = versions[0];
      const def = getSchemaTargetDefinition(target);
      return {
        id: `${entityId}:${target}`,
        targetFormat: def?.displayName ?? target,
        emittedVersion: latest ? `v${latest.version}` : null,
        versions,
      };
    });
}

/** The target key of one of THIS entity's emission target ids (`<entityId>:<target>`), or null for any other id. */
function emissionTargetKey(entityId: string, targetId: unknown): string | null {
  const prefix = `${entityId}:`;
  return typeof targetId === "string" && targetId.startsWith(prefix) && targetId.length > prefix.length ? targetId.slice(prefix.length) : null;
}

export async function getEntityDeploymentStatusAction(
  entityId: string
): Promise<{ success: true; data: DeploymentStatus[] } | { error: string; code?: string }> {

  try {
    const access = await guardSubject("deploy.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { error: "Entity not found" };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targets = buildEmissionTargets(entityId, schemaVersions);

    const res = await getDeploymentStatus(entityId, targets);
    if (!res.success) return { ...failureOf(res.error, "getEntityDeploymentStatusAction") };
    return { success: true, data: res.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getEntityDeploymentStatusAction", e) };
  }
}

export async function markEntityDeployedAction(
  entityId: string,
  targetId: string,
  environment: string
): Promise<{ success: true } | { error: string; code?: string }> {

  if (typeof environment !== "string") return { error: "The environment is required" };

  try {
    const access = await guardSubject("deploy.run", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { error: "Entity not found" };

    // The target id is a second client-supplied id: it must be one of THIS entity's emission targets (`<entityId>:<target>`),
    // or the deployment record below would be written for another entity's target.
    const targetKey = emissionTargetKey(entityId, targetId);
    if (targetKey === null) return { ...notFoundFailure("Emission target") };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const versions = schemaVersions[targetKey] ?? [];
    const latest = versions[0];
    if (!latest) return { error: `No emitted version for target "${targetKey}"` };

    const res = await markAsDeployed(
      { emissionTargetId: targetId, environment, versionId: `v${latest.version}` },
      access.principal.userId
    );
    if (!res.success) return { ...failureOf(res.error, "markEntityDeployedAction") };

    revalidatePath("/schemas");
    revalidatePath("/deployments");
    return { success: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("markEntityDeployedAction", e) };
  }
}

export async function checkTargetDriftAction(
  entityId: string,
  targetId: string
): Promise<{ success: true; data: DeploymentStatus[] } | { error: string; code?: string }> {

  try {
    const access = await guardSubject("deploy.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, select: { metadata: true } });
    if (!entity) return { error: "Entity not found" };

    // The target id must be one of THIS entity's emission targets (see markEntityDeployedAction).
    const targetKey = emissionTargetKey(entityId, targetId);
    if (targetKey === null) return { ...notFoundFailure("Emission target") };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const versions = schemaVersions[targetKey] ?? [];

    const targets = buildEmissionTargets(entityId, schemaVersions);
    const statusRes = await getDeploymentStatus(entityId, targets);
    if (!statusRes.success) return { ...failureOf(statusRes.error, "checkTargetDriftAction") };

    // Drift is judged per environment, against the version that environment's own deployment record names. The schema's one "deployed"
    // version is not the answer: an environment keeps running its version when another version is published or deployed.
    const target = statusRes.data.find((t) => t.targetId === targetId);
    for (const env of target?.environments ?? []) {
      const verdict = environmentDriftVerdict(versions, Number(env.deployedVersion));
      const upd = await updateDriftStatus(targetId, env.name, verdict.driftReport, verdict.isDrifted);
      if (!upd.success) return { ...failureOf(upd.error, "checkTargetDriftAction") };
    }

    const refreshed = await getDeploymentStatus(entityId, targets);
    if (!refreshed.success) return { ...failureOf(refreshed.error, "checkTargetDriftAction") };

    revalidatePath("/deployments");
    return { success: true, data: refreshed.data };
  } catch (e: unknown) {
    return { ...unexpectedFailure("checkTargetDriftAction", e) };
  }
}

// ---------------------------------------------------------------------------
// TypeSpec Source — direct view/edit of the entity's real TypeSpec document
// (architecture.md "TypeSpec Integration", Epic 12 Story 12.5 / Journey 7).
// ---------------------------------------------------------------------------

/**
 * Get this entity's TypeSpec source. Lazily generates it from the current
 * field rows on first access (Story 12.7, incremental rather than a big
 * upfront migration job) — existing entities get a typespecSource the first
 * time anyone opens the TypeSpec Source tab, not before.
 *
 * A stored source flagged `metadata.sourceStale` (field rows were edited
 * outside this tab since it was written, R42) is regenerated the same way, so
 * the tab never shows — or re-saves — a source that lacks those edits.
 */
export async function getTypeSpecSourceAction(entityId: string) {

  try {
    const access = await guardSubject("entity.read", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };
    const entity = await prisma.entity.findUnique({ where: { id: entityId }, include: { domain: true } });
    if (!entity) return { ...notFoundFailure("Entity") };

    if (entity.typespecSource && !isSourceStale(entity.metadata)) {
      // A source stored before Story 16.6 (a publish wrote the generator's text back) can carry `@tag(...)`
      // on the model / properties, which real TypeSpec rejects; rewrite it losslessly into the valid
      // governance decorators so the tab can save it. A no-op (same string) for any other source.
      return { success: true as const, source: upgradeLegacyTagDecorators(entity.typespecSource), generated: false };
    }

    // Lazy-generate from current field rows — this entity hasn't been opened
    // in the TypeSpec Source tab since this feature shipped.
    const model = await loadEntityModel(prisma, entityId);
    if (!model.success) return { ...failureOf(model.error, "getTypeSpecSourceAction") };

    const source = generateTypeSpec(model.data);
    return { success: true as const, source, generated: true };
  } catch (e: unknown) {
    return { ...unexpectedFailure("getTypeSpecSourceAction", e) };
  }
}

export interface TypeSpecSourceSaveResult {
  success: boolean;
  diagnostics: GovernanceDiagnostic[];
  applied?: { added: number; updated: number; removed: string[] };
  error?: string;
  /**
   * The save wrote nothing because a field's type names a model that several entities of the tenant have (`useReferencePick` asks, and the
   * pick comes back as `picks` on the next call). `entityId` is the entity being saved; `fieldId` the row of the field when it has one
   * (an empty string for a field the source adds).
   */
  needsReference?: PublishNeedsReference;
}

/**
 * Compile hand-edited TypeSpec source through the real @typespec/compiler
 * and the governance decorator package. Rejects the save in full on any
 * blocking (error-severity) diagnostic — the entity's stored typespecSource
 * is never partially overwritten. On success, persists the source and
 * regenerates the entity's fields from the compiled result.
 *
 * A field may be typed with the name of ANOTHER entity of the active tenant (`address: Address;`, or qualified
 * `address: Billing.Payments.Address;`): the name is resolved with the closure's resolver and the field is stored as a qualified reference
 * with the entity id (no version: only a pin tag stores one). A name with several matches is never guessed: nothing is written and the
 * answer is `needsReference`; the pick the author makes comes back as `picks` (field name -> entity id, one of the candidates). The text
 * stays as typed.
 */
export async function compileAndApplyTypeSpecSourceAction(
  entityId: string,
  source: string,
  /** Picks for the names an earlier call asked about: field name -> the id of the entity chosen. Anything that is not one of the candidates is ignored. */
  picks?: Record<string, string>
): Promise<TypeSpecSourceSaveResult> {
  try {
    return await compileAndApplyTypeSpecSource(entityId, source, picks);
  } catch (e: unknown) {
    // Anything unexpected (a driver / Prisma message with an absolute path, a compiler crash) is logged and answered
    // generically, in the shape the Source tab reads: the tab leaves "Saving..." and shows `error` in a toast. A disallowed
    // import (TYPESPEC_IMPORT_NOT_ALLOWED) is NOT unexpected: the compiler returns it as an ordinary diagnostic below.
    return { success: false, diagnostics: [], error: unexpectedFailure("compileAndApplyTypeSpecSourceAction", e).error };
  }
}

/**
 * The message of a built-in type name given to something the source declares, or null (the same names TypeSpec itself resolves without a
 * declaration). `own`: the model is the entity's own (the first model of the source), which is named after the ENTITY: the way out is to
 * rename the entity (or the model in the text). The lowercase built-ins people do not think of are named, since an entity called `Url` or
 * `duration` is an easy way to meet this.
 */
function stdTypeNameMessage(kind: string, name: string, own = false): string | null {
  if (!TYPESPEC_STD_TYPE_NAMES.has(name)) return null;
  const noun = kind.toLowerCase();
  const wayOut = own ? "The model is named after the entity: rename the entity, or the model in the source." : `Rename the ${noun}.`;
  return `${kind} "${name}" is named like a TypeSpec built-in type: a field typed "${name}" would mean this ${noun} instead of the built-in. ${wayOut} (Lowercase names such as url, duration, float and decimal are TypeSpec built-ins too.)`;
}

async function compileAndApplyTypeSpecSource(
  entityId: string,
  source: string,
  picks?: unknown
): Promise<TypeSpecSourceSaveResult> {
  // The guard BEFORE anything is loaded: a malformed, missing or foreign id is the same "Entity not found" (a malformed id is rejected without a
  // query, so it never reaches a Prisma validator), a role that cannot edit the entity is refused, and nothing is compiled or written.
  const access = await guardSubject("entity.write", { kind: "entity", id: entityId }, { label: "Entity" });
  if (!access.allowed) return { success: false, diagnostics: [], error: access.refusal.error };
  const userId = access.principal.userId;
  if (typeof source !== "string") {
    return { success: false, diagnostics: [], error: "The TypeSpec source must be text" };
  }

  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) {
    return { success: false, diagnostics: [], error: "Entity not found" };
  }

  // The entity's own rows (which fields the source drops, which references it already stores) and its tenant's entities (what a name
  // written as a field's type can mean; the entity was just checked to be in the active tenant). Each is read once, on first use: a
  // source that does not compile, or names nothing outside itself, reads neither.
  const readFieldRows = () =>
    prisma.field.findMany({ where: { entityId }, select: { id: true, name: true, type: true, decorators: true } });
  let fieldRows: ReturnType<typeof readFieldRows> | undefined;
  const loadFieldRows = () => (fieldRows ??= readFieldRows());
  let tenantRefs: ReturnType<typeof loadTenantEntityRefs> | undefined;
  const loadRefs = () => (tenantRefs ??= loadTenantEntityRefs(prisma, entity.tenantId));

  // A field typed with the name of another entity compiles only when that name is declared somewhere, and in this one document it is
  // not. The compile is told which of the names it could not find are entities of the tenant (or references this entity already stores),
  // and checks the rest of the source with an empty stand-in for each: the stand-ins live in a separate file of that one compile and are
  // never stored or emitted.
  const result = await compileTypeSpecWithGovernance(source, {
    externalModels: async (written, unionOnly) => {
      const refs = await loadRefs();
      if (!refs.success) return new Set<string>();
      const resolve = createNameResolver(refs.data);
      const storedNames = storedReferenceNames(await loadFieldRows());
      // A name some field already refers to may stay (its entity is gone or renamed), unless it is only ever a union member: a union
      // member is no reference, so a stored reference licenses nothing there and the tenant must have the name.
      return new Set(
        written.slice(0, MAX_WRITTEN_NAMES).filter((name) => (!unionOnly.has(name) && storedNames.has(name)) || resolve(name) !== undefined),
      );
    },
  });
  if (!result.success) {
    // The TypeSpec compiler refused the source: the Health card "Compilation Errors" counts it (the first messages only, as a short note).
    await recordAuditFailure({
      action: "COMPILATION_ERROR",
      entityType: "Entity",
      entityId,
      userId,
      details: { messages: result.diagnostics.slice(0, 5).map((d) => String((d as { message?: unknown }).message ?? "").slice(0, 300)) },
    });
    return { success: false, diagnostics: result.diagnostics };
  }
  const existingFields = await loadFieldRows();

  const model = result.document.models[0];
  if (!model) {
    return {
      success: false,
      diagnostics: [
        ...result.diagnostics,
        { severity: "error", code: "no-model", message: "No model found — define at least one model for this entity." },
      ],
    };
  }

  // The first model becomes the entity's field rows (`applyTypeSpecAction` refuses a NEW field named like a key the AsyncAPI parser cannot
  // read). The other models of the source (the nested types the entity refers to) have no rows, so there is no "existing" field to spare:
  // one of them with such a field is refused. INLINE anonymous models are not listed in the parsed document, so their property names are
  // not visible here; the emit guard catches those.
  // The message says WHICH model, enum, scalar or union holds the name (`Model "Address": "x" is a reserved name: ...`).
  for (const other of result.document.models.slice(1)) {
    const reserved = reservedNameMessage(other.name) ?? firstReservedFieldNameMessage(other.fields);
    if (reserved !== null) return { success: false, diagnostics: result.diagnostics, error: `Model "${other.name}": ${reserved}` };
  }
  // The names of the enums, scalars and unions the source declares become definition keys of a payload too.
  const { enums = [], scalars = [], unions = [] } = result.document;
  const declaredNames = [
    ...enums.map((d) => ["Enum", d.name]),
    ...scalars.map((d) => ["Scalar", d.name]),
    ...unions.map((d) => ["Union", d.name]),
  ];
  for (const [kind, name] of declaredNames) {
    const reserved = reservedNameMessage(name);
    if (reserved !== null) return { success: false, diagnostics: result.diagnostics, error: `${kind} "${name}": ${reserved}` };
  }

  // A model, enum, scalar or union NAMED like a TypeSpec built-in (`model string`, `enum int32`) takes the name over: every field typed with
  // the built-in is then read as that declaration, or the declaration as the built-in. The save is refused rather than silently mistyped.
  const builtInOwn = stdTypeNameMessage("Model", model.name, true);
  if (builtInOwn !== null) return { success: false, diagnostics: result.diagnostics, error: builtInOwn };
  for (const [kind, name] of [...result.document.models.slice(1).map((m) => ["Model", m.name]), ...declaredNames]) {
    const builtIn = stdTypeNameMessage(kind, name);
    if (builtIn !== null) return { success: false, diagnostics: result.diagnostics, error: builtIn };
  }

  // The names the fields of the entity's model write as their type that are NOT declared by the source: an entity of the tenant, or this
  // entity itself (its own model's name). Resolved with the closure's resolver; several matches are asked about, nothing is written.
  const typeNames = result.fieldTypeNames ?? [];
  const external = result.externalModels ?? new Set<string>();
  // A member of a field's union is not stored as a reference (a union holds member NAMES): it only had to compile.
  const candidates = typeNames.flatMap((n) =>
    n.shape !== "union" && (external.has(n.written) || n.written === model.name) ? [{ field: n.field, written: n.written, shape: n.shape }] : [],
  );
  let references: ReadonlyMap<string, SourceReference> | undefined;
  if (candidates.length > 0) {
    const refs = await loadRefs();
    if (!refs.success) return { success: false, diagnostics: result.diagnostics, error: "Entity not found" };
    const resolved = resolveSourceReferences({
      fields: candidates,
      stored: new Map(existingFields.map((f) => [f.name, f])),
      self: { entityId, modelName: model.name },
      refs: refs.data,
      picks,
    });
    if (!resolved.ok) {
      const { field, name, candidates: matches, fieldId } = resolved.ambiguous;
      return {
        success: false,
        diagnostics: result.diagnostics,
        needsReference: { field, name, candidates: matches, entityId, fieldId },
        error: `Field "${field}" refers to "${name}", which matches ${matches.length} entities. Choose the entity it means on that field, then save again.`,
      };
    }
    // A name that compiled only because ANOTHER field already refers to it (and its entity is gone) is still unknown on this field.
    if (resolved.unresolved.length > 0) {
      return {
        success: false,
        diagnostics: [
          ...result.diagnostics,
          ...resolved.unresolved.map((f) => ({ severity: "error" as const, code: "invalid-ref", message: `Unknown identifier ${f.written}` })),
        ],
      };
    }
    references = resolved.references;
  }

  const newFieldNames = new Set(model.fields.map((f) => f.name));
  const fieldsToRemove = existingFields
    .map((f) => f.name)
    .filter((name) => !newFieldNames.has(name));

  const fieldGovernance: Record<string, FieldGovernanceInfo> = {};
  for (const [key, info] of Object.entries(result.fieldGovernance)) {
    const [modelName, fieldName] = key.split(".");
    if (modelName === model.name && fieldName) {
      fieldGovernance[fieldName] = info;
    }
  }

  // The source is canonical: its model tags (`x-tags`, or a legacy `@tag`) become the entity's tags, so a
  // tag edit made here persists and is not reverted by the next regeneration from `metadata.tags`.
  // Only written when they differ, so a save that does not touch tags leaves the metadata alone.
  const sourceTagList = model.tags ?? [];
  const storedTags = (entity.metadata as { tags?: unknown } | null)?.tags;
  const currentTagList = Array.isArray(storedTags) ? storedTags : [];
  const sourceTags =
    sourceTagList.length === currentTagList.length && sourceTagList.every((t, i) => t === currentTagList[i])
      ? null
      : sourceTagList;

  // The model's generic vendor extensions (`@extension` above the model) are the entity's `metadata.custom.extensions`, written like
  // the tags: only when they differ, only that one key.
  const extensionsChange = entityExtensionsChange(entity.metadata, model.extensions);

  const applyResult = await applyTypeSpecFields(
    entityId,
    model.fields.map((f) => ({
      name: f.name,
      type: f.type,
      isOptional: f.isOptional,
      isKey: f.isKey,
      decorators: f.decorators as Record<string, unknown>,
      arrayElementType: f.arrayElementType,
      ...(f.nullableType ? { nullableType: true } : {}),
      ...(f.unionMembers ? { unionMembers: f.unionMembers } : {}),
      ...(f.unionName ? { unionName: f.unionName } : {}),
    })),
    fieldsToRemove,
    fieldGovernance,
    new Map(enums.map((d) => [d.name, d.values] as const)),
    references,
    new Set([...result.document.models.map((m) => m.name), ...enums.map((d) => d.name), ...scalars.map((d) => d.name), ...unions.map((d) => d.name)]),
  );

  if (applyResult.error) {
    return { success: false, diagnostics: result.diagnostics, error: applyResult.error };
  }

  await withAudit({
    action: "UPDATE",
    entityType: "Entity",
    entityId,
    userId,
    beforeState: { typespecSource: entity.typespecSource } as unknown as object,
    fn: async () => {
      // Source + fields were just written consistently: save the source and clear
      // `sourceStale` (set by applyTypeSpecAction above) in one atomic batch.
      const [updated] = await prisma.$transaction([
        prisma.entity.update({
          where: { id: entityId },
          data: { typespecSource: source, hasUnpublishedChanges: true },
        }),
        ...(sourceTags
          ? [prisma.$executeRawUnsafe(SET_ENTITY_TAGS_SQL, entityId, JSON.stringify(sourceTags))]
          : []),
        ...(extensionsChange.kind === "set"
          ? [prisma.$executeRawUnsafe(SET_ENTITY_EXTENSIONS_SQL, entityId, JSON.stringify(extensionsChange.value))]
          : extensionsChange.kind === "clear"
            ? [prisma.$executeRawUnsafe(CLEAR_ENTITY_EXTENSIONS_SQL, entityId)]
            : []),
        prisma.$executeRawUnsafe(CLEAR_SOURCE_STALE_SQL, entityId),
      ]);
      return updated;
    },
  });

  revalidatePath("/schemas");
  return {
    success: true,
    diagnostics: result.diagnostics,
    applied: {
      added: applyResult.added,
      updated: applyResult.updated,
      removed: applyResult.removed,
    },
  };
}
