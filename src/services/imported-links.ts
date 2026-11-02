// src/services/imported-links.ts
// Links an imported entity to entities that ALREADY exist in its product (the other files of a schema folder, imported one by one):
// - a field whose `$ref` points at a file that is not part of the document keeps a dangling marker; when the product has an entity of
//   that name the marker is replaced by a real reference (and, the other way round, a new entity picks up the dangling fields that name it);
import { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { readDanglingMarker } from "@/lib/field-dangling";
import { withoutReferenceKeys, writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";

type Target = { id: string; name: string };

function decoratorsOf(field: CreateFieldInput): Record<string, unknown> | undefined {
  const value = field.decorators;
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** The name a dangling field points at, `undefined` when the field is not dangling. */
function danglingTargetName(decorators: Record<string, unknown> | undefined): string | undefined {
  if (!decorators || readDanglingMarker(decorators) === undefined) return undefined;
  const name = decorators.referencedEntityName;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** The decorators of a dangling field once it points at `target`: a qualified reference, no marker. */
export function linkedDecorators(decorators: Record<string, unknown>, target: Target, place: Pick<EntityRef, "domain" | "product">): Record<string, unknown> {
  const { danglingRef: _marker, ...rest } = decorators;
  void _marker;
  return writeFieldReference(rest, { domain: place.domain, product: place.product, entity: target.name, entityId: target.id });
}

/** `fields` with every dangling field whose target is among `targets` (by name) linked to it. Pure. */
export function linkFields(fields: CreateFieldInput[], targets: ReadonlyMap<string, Target>, place: Pick<EntityRef, "domain" | "product">): CreateFieldInput[] {
  return fields.map((field) => {
    const decorators = decoratorsOf(field);
    const name = danglingTargetName(decorators);
    const target = name === undefined ? undefined : targets.get(name);
    return decorators && target ? { ...field, decorators: linkedDecorators(decorators, target, place) } : field;
  });
}

async function placeOf(tx: Prisma.TransactionClient, productId: string): Promise<(Pick<EntityRef, "domain" | "product"> & { domainId?: string }) | undefined> {
  const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true, domainId: true, domain: { select: { name: true } } } });
  return product ? { domain: product.domain.name, product: product.name, ...(product.domainId ? { domainId: product.domainId } : {}) } : undefined;
}

type EnumTarget = { name: string; values: string[] };

/** The field once it points at the shared enum `target` instead of at a file nothing answered: an enum field, or an array of enum symbols. Pure. */
export function linkFieldToEnum(field: CreateFieldInput, target: EnumTarget): CreateFieldInput {
  const decorators = decoratorsOf(field);
  const marker = decorators ? readDanglingMarker(decorators) : undefined;
  if (!decorators || !marker) return field;
  const { danglingRef: _marker, ...rest } = withoutReferenceKeys(decorators);
  void _marker;
  if (marker.element) {
    return { ...field, decorators: { ...rest, arrayElementType: "enum", enumValues: target.values, enumName: target.name } };
  }
  // An enum field keeps its symbols in `typespec.validation.pattern` ("A|B"), which the generator reads for it.
  const typespec = (rest.typespec && typeof rest.typespec === "object" ? rest.typespec : {}) as Record<string, unknown>;
  const validation = (typespec.validation && typeof typespec.validation === "object" ? typespec.validation : {}) as Record<string, unknown>;
  return {
    ...field,
    type: "enum",
    decorators: { ...rest, enumName: target.name, typespec: { ...typespec, validation: { ...validation, pattern: target.values.join("|") } } },
  };
}

/** `fields` with every dangling field whose target is a shared enum among `enums` (by name) linked to it. Pure. */
export function linkFieldsToEnums(fields: CreateFieldInput[], enums: ReadonlyMap<string, EnumTarget>): CreateFieldInput[] {
  return fields.map((field) => {
    const name = danglingTargetName(decoratorsOf(field));
    const target = name === undefined ? undefined : enums.get(name);
    return target ? linkFieldToEnum(field, target) : field;
  });
}

/**
 * Before an imported entity is created: its dangling fields are linked to the product's existing entities. One query for the targets,
 * none when the entity has no dangling field.
 *
 * `extends` is NOT resolved here: the base is kept by NAME on the entity (`metadata.extends`, see {@link EXTENDS_METADATA_KEY}) and found
 * again, as the latest version of the entity of that name, whenever a schema is generated.
 */
export async function linkImportedEntity(
  tx: Prisma.TransactionClient,
  args: { productId: string; fields: CreateFieldInput[] },
): Promise<{ fields: CreateFieldInput[] }> {
  const names = new Set<string>();
  for (const field of args.fields) {
    const name = danglingTargetName(decoratorsOf(field));
    if (name !== undefined) names.add(name);
  }
  if (names.size === 0) return { fields: args.fields };

  const rows = await tx.entity.findMany({ where: { productId: args.productId, name: { in: [...names] } }, select: { id: true, name: true } });
  const place = await placeOf(tx, args.productId);
  const linked = place && rows.length > 0 ? linkFields(args.fields, new Map(rows.map((row) => [row.name, row])), place) : args.fields;

  // What no entity answers to may be a shared ENUM of the domain (a `$ref` to an enum file): the field becomes an enum field.
  const rest = [...names].filter((name) => !rows.some((row) => row.name === name));
  if (rest.length === 0 || !place?.domainId) return { fields: linked };
  const enums = await tx.sharedEnum.findMany({ where: { domainId: place.domainId, name: { in: rest } }, select: { name: true, values: true } });
  return { fields: enums.length > 0 ? linkFieldsToEnums(linked, new Map(enums.map((row) => [row.name, row]))) : linked };
}

/** The entity metadata key that holds the NAME of the entity this one extends (an `allOf` base of another file). */
export const EXTENDS_METADATA_KEY = "extends";

/** The acting user and tenant an audit row written by these helpers is recorded under (what `withAudit` takes from its caller). */
export type AuditActor = { userId: string; tenantId: string };

/**
 * Writes an audit row through the caller's transaction, so it commits or rolls back with the write it records. The row has the shape
 * `withAudit` writes (the states, the acting tenant). Used where the write runs inside a transaction that `withAudit`'s own client cannot join.
 */
export async function auditInTransaction(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  entry: { action: "CREATE" | "UPDATE"; entityType: "Entity" | "Field"; entityId: string; beforeState?: object; afterState: object },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      userId: actor.userId,
      tenantId: actor.tenantId,
      beforeState: entry.beforeState !== undefined ? (entry.beforeState as Prisma.InputJsonValue) : Prisma.JsonNull,
      afterState: entry.afterState as Prisma.InputJsonValue,
    },
  });
}

/**
 * After an imported entity is created: the product's fields that still point at its name as a dangling reference are linked to it
 * (files imported in any order end up linked). Each linked field is audited (an UPDATE of the field, under `actor`). Returns how many
 * fields were linked.
 */
export async function relinkDanglingFields(tx: Prisma.TransactionClient, args: { productId: string; entity: Target; actor: AuditActor }): Promise<number> {
  const candidates = await tx.field.findMany({
    where: { entity: { productId: args.productId }, decorators: { path: ["referencedEntityName"], equals: args.entity.name }, entityId: { not: args.entity.id } },
    select: { id: true, entityId: true, name: true, type: true, decorators: true },
  });
  const dangling = candidates.filter((row) => readDanglingMarker(row.decorators) !== undefined);
  if (dangling.length === 0) return 0;
  const place = await placeOf(tx, args.productId);
  if (!place) return 0;
  for (const row of dangling) {
    const decorators = row.decorators as Record<string, unknown>;
    const linked = linkedDecorators(decorators, args.entity, place) as Prisma.InputJsonObject;
    await tx.field.update({ where: { id: row.id }, data: { decorators: linked } });
    await auditInTransaction(tx, args.actor, {
      action: "UPDATE",
      entityType: "Field",
      entityId: row.id,
      beforeState: row,
      afterState: { ...row, decorators: linked },
    });
  }
  return dangling.length;
}

/**
 * After a shared enum is created: the domain's entities' fields that still point at its name as a dangling reference become enum fields
 * of it (files imported in any order end up linked). Returns how many fields were linked.
 */
export async function relinkDanglingFieldsToEnum(tx: Prisma.TransactionClient, args: { domainId: string; enum: EnumTarget; actor: AuditActor }): Promise<number> {
  const candidates = await tx.field.findMany({
    where: { entity: { domainId: args.domainId }, decorators: { path: ["referencedEntityName"], equals: args.enum.name } },
    select: { id: true, entityId: true, name: true, type: true, decorators: true },
  });
  let linked = 0;
  for (const row of candidates) {
    if (readDanglingMarker(row.decorators) === undefined) continue;
    const decorators = row.decorators as Record<string, unknown>;
    const input = { name: row.name, type: row.type, nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, decorators } satisfies CreateFieldInput;
    const next = linkFieldToEnum(input, args.enum);
    if (next === input) continue;
    await tx.field.update({ where: { id: row.id }, data: { type: next.type, decorators: next.decorators as Prisma.InputJsonObject } });
    await auditInTransaction(tx, args.actor, {
      action: "UPDATE",
      entityType: "Field",
      entityId: row.id,
      beforeState: row,
      afterState: { ...row, type: next.type, decorators: next.decorators },
    });
    linked += 1;
  }
  return linked;
}
