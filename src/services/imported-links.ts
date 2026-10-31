// src/services/imported-links.ts
// Links an imported entity to entities that ALREADY exist in its product (the other files of a schema folder, imported one by one):
// - a field whose `$ref` points at a file that is not part of the document keeps a dangling marker; when the product has an entity of
//   that name the marker is replaced by a real reference (and, the other way round, a new entity picks up the dangling fields that name it);
// - `extends` names a base defined in another file: it becomes the entity's parent when the product has it.
import type { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { readDanglingMarker } from "@/lib/field-dangling";
import { mapFieldCreateInput } from "@/lib/entity-field-input";
import { writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";

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

async function placeOf(tx: Prisma.TransactionClient, productId: string): Promise<Pick<EntityRef, "domain" | "product"> | undefined> {
  const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true, domain: { select: { name: true } } } });
  return product ? { domain: product.domain.name, product: product.name } : undefined;
}

/** A stored field as the create input of a copy of it. */
function copyOf(row: { name: string; type: string; nullable: boolean; isKey: boolean; description: string; classification: string | null; precision: number | null; scale: number | null; fieldNumber: number | null; aliases: string[]; decorators: unknown }): CreateFieldInput {
  const decorators = row.decorators && typeof row.decorators === "object" && !Array.isArray(row.decorators) ? (row.decorators as Record<string, unknown>) : undefined;
  return {
    name: row.name, type: row.type, nullable: row.nullable, isKey: row.isKey, description: row.description, classification: row.classification,
    precision: row.precision, scale: row.scale, ...(row.fieldNumber !== null ? { fieldNumber: row.fieldNumber } : {}),
    ...(row.aliases.length > 0 ? { aliases: row.aliases } : {}), ...(decorators && Object.keys(decorators).length > 0 ? { decorators } : {}),
  };
}

/**
 * Before an imported entity is created: its dangling fields and its `extends` are linked to the product's existing entities.
 * One query for the targets, none when the entity has neither.
 *
 * The base's fields are COPIED in front of the entity's own (an own field of the same name wins): the entity's fields are all it validates
 * with, and the generator does not write `extends` for a stored entity, so an `allOf` base that was only linked would drop its properties.
 */
export async function linkImportedEntity(
  tx: Prisma.TransactionClient,
  args: { productId: string; fields: CreateFieldInput[]; extends?: string },
): Promise<{ fields: CreateFieldInput[]; parentEntityId?: string; inherited?: { from: string; count: number }; pendingBase?: string }> {
  const names = new Set<string>();
  for (const field of args.fields) {
    const name = danglingTargetName(decoratorsOf(field));
    if (name !== undefined) names.add(name);
  }
  if (args.extends) names.add(args.extends);
  if (names.size === 0) return { fields: args.fields };
  // A base the product does not have yet: remembered on the entity, so the base's fields reach it when the base is imported.
  const pending = args.extends ? { pendingBase: args.extends } : {};

  const rows = await tx.entity.findMany({ where: { productId: args.productId, name: { in: [...names] } }, select: { id: true, name: true } });
  if (rows.length === 0) return { fields: args.fields, ...pending };
  const targets = new Map(rows.map((row) => [row.name, row]));
  const place = await placeOf(tx, args.productId);
  const own = place ? linkFields(args.fields, targets, place) : args.fields;
  const base = args.extends ? targets.get(args.extends) : undefined;
  if (!base) return { fields: own, ...pending };
  const taken = new Set(own.map((field) => field.name));
  const baseRows = await tx.field.findMany({ where: { entityId: base.id }, orderBy: { sortOrder: "asc" } });
  const inherited = baseRows.filter((row) => !taken.has(row.name)).map(copyOf);
  return {
    fields: [...inherited, ...own],
    parentEntityId: base.id,
    ...(inherited.length > 0 ? { inherited: { from: base.name, count: inherited.length } } : {}),
  };
}

/**
 * After an imported entity is created: the product's fields that still point at its name as a dangling reference are linked to it
 * (files imported in any order end up linked). Returns how many fields were linked.
 */
export async function relinkDanglingFields(tx: Prisma.TransactionClient, args: { productId: string; entity: Target }): Promise<number> {
  const candidates = await tx.field.findMany({
    where: { entity: { productId: args.productId }, decorators: { path: ["referencedEntityName"], equals: args.entity.name }, entityId: { not: args.entity.id } },
    select: { id: true, decorators: true },
  });
  const dangling = candidates.filter((row) => readDanglingMarker(row.decorators) !== undefined);
  if (dangling.length === 0) return 0;
  const place = await placeOf(tx, args.productId);
  if (!place) return 0;
  for (const row of dangling) {
    const decorators = row.decorators as Record<string, unknown>;
    await tx.field.update({ where: { id: row.id }, data: { decorators: linkedDecorators(decorators, args.entity, place) as Prisma.InputJsonObject } });
  }
  return dangling.length;
}

/** The entity metadata key that remembers a base which was not in the product when the entity was imported. */
export const PENDING_BASE_KEY = "pendingBase";

/**
 * After an imported entity is created: the product's entities that were imported before it and extend it (`pendingBase`) get its fields
 * copied in front of their own, are linked to it as their parent, and forget the pending base. Returns the names of the entities completed.
 */
export async function adoptBaseFields(tx: Prisma.TransactionClient, args: { productId: string; entity: Target }): Promise<string[]> {
  const waiting = await tx.entity.findMany({
    where: { productId: args.productId, id: { not: args.entity.id }, metadata: { path: [PENDING_BASE_KEY], equals: args.entity.name } },
    select: { id: true, name: true, metadata: true },
  });
  if (waiting.length === 0) return [];
  const baseRows = await tx.field.findMany({ where: { entityId: args.entity.id }, orderBy: { sortOrder: "asc" } });
  const done: string[] = [];
  for (const child of waiting) {
    const own = await tx.field.findMany({ where: { entityId: child.id }, select: { name: true } });
    const taken = new Set(own.map((row) => row.name));
    const inherited = baseRows.filter((row) => !taken.has(row.name)).map(copyOf);
    if (inherited.length > 0) {
      await tx.field.updateMany({ where: { entityId: child.id }, data: { sortOrder: { increment: inherited.length } } });
      for (const [index, field] of inherited.entries()) {
        await tx.field.create({ data: { ...mapFieldCreateInput(field, index), entity: { connect: { id: child.id } } } });
      }
    }
    const { [PENDING_BASE_KEY]: _pending, ...rest } = (child.metadata && typeof child.metadata === "object" && !Array.isArray(child.metadata) ? child.metadata : {}) as Record<string, unknown>;
    void _pending;
    await tx.entity.update({ where: { id: child.id }, data: { parentEntityId: args.entity.id, metadata: rest as Prisma.InputJsonObject } });
    done.push(child.name);
  }
  return done;
}
