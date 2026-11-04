// src/services/imported-links.ts
// Links an imported entity to entities that ALREADY exist in its domain (the other files of a schema folder, imported one by one; the same
// product first, then any product of the domain when the name is unique there). A `$ref` names a FILE (`country_code.json`) and an asset a
// title (`CountryCode`), so names are compared by `sameAssetName` (case and separators ignored):
// - a field whose `$ref` points at a file that is not part of the document keeps a dangling marker; when the product has an entity of
//   that name the marker is replaced by a real reference (and, the other way round, a new entity picks up the dangling fields that name it);
import type { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { readDanglingMarker } from "@/lib/field-dangling";
import { withoutReferenceKeys, writeFieldReference, type EntityRef } from "@/lib/references/entity-reference";
import { sameAssetName } from "@/lib/importers/asset-name-match";
import { applyScalarToField, type ScalarFacts } from "@/lib/importers/scalar-asset";

type Target = { id: string; name: string; sourceRef?: string };

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

type EnumTarget = { name: string; values: string[]; valueDescriptions?: Record<string, string>; sourceRef?: string | null };

/** The `valueDescriptions` column as a symbol -> text map (it comes from stored JSON). */
export function readValueDescriptions(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string" && v !== "") out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The field once it points at the shared enum `target` instead of at a file nothing answered: an enum field, or an array of enum symbols. Pure. */
export function linkFieldToEnum(field: CreateFieldInput, target: EnumTarget): CreateFieldInput {
  const decorators = decoratorsOf(field);
  const marker = decorators ? readDanglingMarker(decorators) : undefined;
  if (!decorators || !marker) return field;
  const { danglingRef: _marker, ...rest } = withoutReferenceKeys(decorators);
  void _marker;
  if (marker.element) {
    return { ...field, decorators: { ...rest, arrayElementType: "enum", enumValues: target.values, enumName: target.name, ...(target.valueDescriptions ? { enumValueDescriptions: target.valueDescriptions } : {}) } };
  }
  // An enum field keeps its symbols in `typespec.validation.pattern` ("A|B"), which the generator reads for it.
  const typespec = (rest.typespec && typeof rest.typespec === "object" ? rest.typespec : {}) as Record<string, unknown>;
  const validation = (typespec.validation && typeof typespec.validation === "object" ? typespec.validation : {}) as Record<string, unknown>;
  return {
    ...field,
    type: "enum",
    decorators: { ...rest, enumName: target.name, ...(target.valueDescriptions ? { enumValueDescriptions: target.valueDescriptions } : {}), typespec: { ...typespec, validation: { ...validation, pattern: target.values.join("|") } } },
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

type DomainEntity = { id: string; name: string; productId: string | null; sourceRef?: string };

/** True when a reference spelled `name` means `asset`: by its own name, or by the file it was imported from. */
function namesAsset(asset: { name: string; sourceRef?: string | null }, name: string): boolean {
  return sameAssetName(asset.name, name) || (asset.sourceRef != null && sameAssetName(asset.sourceRef, name));
}

/**
 * The asset a dangling name stands for among `rows`: the one of the field's own product when there is one, else the only one in the
 * domain. Several candidates in other products are ambiguous: nothing is linked (the field stays visibly dangling).
 */
export function pickByName<T extends { name: string; sourceRef?: string | null; productId?: string | null }>(rows: readonly T[], name: string, ownProductId?: string): T | undefined {
  const matches = rows.filter((row) => namesAsset(row, name));
  if (matches.length === 0) return undefined;
  const own = ownProductId === undefined ? [] : matches.filter((row) => row.productId === ownProductId);
  if (own.length > 0) return own[0];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Fields of a domain (given by id, or by one of its products) that still carry a dangling marker. */
async function danglingFieldsOfDomain(tx: Prisma.TransactionClient, scope: { domainId: string } | { productId: string }, exceptEntityId?: string) {
  const entity = "domainId" in scope ? { domainId: scope.domainId } : { domain: { products: { some: { id: scope.productId } } } };
  return tx.field.findMany({
    where: {
      entity,
      ...(exceptEntityId ? { entityId: { not: exceptEntityId } } : {}),
      decorators: { path: ["danglingRef", "ref"], string_contains: "" },
    },
    select: { id: true, name: true, type: true, entityId: true, decorators: true, entity: { select: { productId: true } } },
  });
}

async function domainEntities(tx: Prisma.TransactionClient, domainId: string): Promise<DomainEntity[]> {
  const rows = await tx.entity.findMany({ where: { domainId, productId: { not: null } }, select: { id: true, name: true, productId: true, metadata: true } });
  return rows.map((row) => {
    const ref = (row.metadata as { sourceRef?: unknown } | null)?.sourceRef;
    return { id: row.id, name: row.name, productId: row.productId, ...(typeof ref === "string" ? { sourceRef: ref } : {}) };
  });
}

/** `place` (domain + product NAMES) of a product, for writing a qualified reference to one of its entities. */
async function placeOfProduct(tx: Prisma.TransactionClient, productId: string) {
  return placeOf(tx, productId);
}

/**
 * Before an imported entity is created: its dangling fields are linked to the domain's existing entities (own product first), shared
 * enums and shared scalars. Two queries at most per kind, none when the entity has no dangling field.
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

  const place = await placeOf(tx, args.productId);
  if (!place?.domainId) return { fields: args.fields };
  const entities = await domainEntities(tx, place.domainId);
  let fields = args.fields;
  const answered = new Set<string>();
  for (const name of names) {
    const target = pickByName(entities, name, args.productId);
    if (!target || !target.productId) continue;
    const targetPlace = target.productId === args.productId ? place : await placeOfProduct(tx, target.productId);
    if (!targetPlace) continue;
    fields = linkFields(fields, new Map([[name, target]]), targetPlace);
    answered.add(name);
  }

  // What no entity answers to may be a shared ENUM or SCALAR of the domain (a `$ref` to an enum / primitive file).
  const rest = [...names].filter((name) => !answered.has(name));
  if (rest.length === 0) return { fields };
  const enums = await tx.sharedEnum.findMany({ where: { domainId: place.domainId }, select: { name: true, values: true, valueDescriptions: true, sourceRef: true } });
  const scalars = await tx.customScalar.findMany({ where: { domainId: place.domainId }, select: { name: true, baseType: true, logicalType: true, format: true, pattern: true, constraints: true, sourceRef: true } });
  const enumTargets = new Map<string, EnumTarget>();
  const scalarTargets = new Map<string, ScalarTarget>();
  for (const name of rest) {
    const e = pickByName(enums, name);
    if (e) { enumTargets.set(name, { name: e.name, values: e.values, valueDescriptions: readValueDescriptions(e.valueDescriptions) }); continue; }
    const sc = pickByName(scalars, name);
    if (sc) scalarTargets.set(name, sc);
  }
  if (enumTargets.size > 0) fields = linkFieldsToEnums(fields, enumTargets);
  if (scalarTargets.size > 0) fields = linkFieldsToScalars(fields, scalarTargets);
  return { fields };
}

/** The entity metadata key that holds the NAME of the entity this one extends (an `allOf` base of another file). */
export const EXTENDS_METADATA_KEY = "extends";

/**
 * After an imported entity is created: the domain's fields that still point at its name as a dangling reference are linked to it (files
 * imported in any order, in any product of the domain, end up linked). A field of ANOTHER product is linked only when this entity is the
 * only one of that name in the domain. Returns how many fields were linked.
 */
export async function relinkDanglingFields(tx: Prisma.TransactionClient, args: { productId: string; entity: Target }): Promise<number> {
  const candidates = await danglingFieldsOfDomain(tx, { productId: args.productId }, args.entity.id);
  const named = candidates.filter((row) => matchesDangling(row, args.entity));
  if (named.length === 0) return 0;
  const place = await placeOf(tx, args.productId);
  if (!place?.domainId) return 0;
  const sameName = (await domainEntities(tx, place.domainId)).filter((e) => namesAsset(e, args.entity.name) || (args.entity.sourceRef !== undefined && namesAsset(e, args.entity.sourceRef)));
  let linked = 0;
  for (const row of named) {
    const ownProduct = row.entity?.productId;
    const mine = ownProduct === args.productId;
    // another product's entity of that name takes precedence for a field of that product
    const ownCandidate = ownProduct ? sameName.find((e) => e.productId === ownProduct && e.id !== args.entity.id) : undefined;
    if (ownCandidate) continue;
    if (!mine && sameName.length !== 1) continue;
    const decorators = row.decorators as Record<string, unknown>;
    await tx.field.update({ where: { id: row.id }, data: { decorators: linkedDecorators(decorators, args.entity, place) as Prisma.InputJsonObject } });
    linked += 1;
  }
  return linked;
}

type DanglingRow = { id: string; name: string; type: string; decorators: unknown };

function asCreateInput(row: DanglingRow): CreateFieldInput {
  return { name: row.name, type: row.type, nullable: true, isKey: false, description: "", classification: null, precision: null, scale: null, decorators: row.decorators as Record<string, unknown> };
}

function matchesDangling(row: { decorators: unknown }, asset: { name: string; sourceRef?: string | null }): boolean {
  const name = (row.decorators as { referencedEntityName?: unknown } | null)?.referencedEntityName;
  return typeof name === "string" && namesAsset(asset, name) && readDanglingMarker(row.decorators) !== undefined;
}

/**
 * After a shared enum is created: the domain's entities' fields that still point at its name as a dangling reference become enum fields
 * of it (files imported in any order end up linked). Returns how many fields were linked.
 */
export async function relinkDanglingFieldsToEnum(tx: Prisma.TransactionClient, args: { domainId: string; enum: EnumTarget }): Promise<number> {
  let linked = 0;
  for (const row of await danglingFieldsOfDomain(tx, { domainId: args.domainId })) {
    if (!matchesDangling(row, args.enum)) continue;
    const input = asCreateInput(row);
    const next = linkFieldToEnum(input, args.enum);
    if (next === input) continue;
    await tx.field.update({ where: { id: row.id }, data: { type: next.type, decorators: next.decorators as Prisma.InputJsonObject } });
    linked += 1;
  }
  return linked;
}

type ScalarTarget = ScalarFacts & { name: string; sourceRef?: string | null };

/** The field once it uses the shared scalar `target` instead of a file nothing answered. Pure. */
export function linkFieldToScalar(field: CreateFieldInput, target: ScalarTarget): CreateFieldInput {
  const decorators = decoratorsOf(field);
  const marker = decorators ? readDanglingMarker(decorators) : undefined;
  if (!decorators || !marker) return field;
  const { danglingRef: _marker, ...rest } = withoutReferenceKeys(decorators);
  void _marker;
  const applied = applyScalarToField({ type: marker.element ? field.type : "string", decorators: rest }, target.name, target, marker.element === true);
  return { ...field, type: applied.type, decorators: applied.decorators };
}

/** `fields` with every dangling field whose target is a shared scalar among `scalars` (by name) linked to it. Pure. */
export function linkFieldsToScalars(fields: CreateFieldInput[], scalars: ReadonlyMap<string, ScalarTarget>): CreateFieldInput[] {
  return fields.map((field) => {
    const name = danglingTargetName(decoratorsOf(field));
    const target = name === undefined ? undefined : scalars.get(name);
    return target ? linkFieldToScalar(field, target) : field;
  });
}

/** After a shared scalar is created: the domain's dangling fields that name it use it (type, format and constraints copied). */
export async function relinkDanglingFieldsToScalar(tx: Prisma.TransactionClient, args: { domainId: string; scalar: ScalarTarget }): Promise<number> {
  let linked = 0;
  for (const row of await danglingFieldsOfDomain(tx, { domainId: args.domainId })) {
    if (!matchesDangling(row, args.scalar)) continue;
    const input = asCreateInput(row);
    const next = linkFieldToScalar(input, args.scalar);
    if (next === input) continue;
    await tx.field.update({ where: { id: row.id }, data: { type: next.type, decorators: next.decorators as Prisma.InputJsonObject } });
    linked += 1;
  }
  return linked;
}

/**
 * A shared scalar was edited: every field of the domain that records it (`decorators.scalarName`) is re-derived from it, so the scalar is
 * the one place its type, format and bounds are edited. Entities whose fields changed are marked as having unpublished changes. Returns
 * the number of fields updated.
 */
export async function cascadeScalarToFields(tx: Prisma.TransactionClient, args: { domainId: string; scalar: ScalarTarget }): Promise<number> {
  const rows = await tx.field.findMany({
    where: { entity: { domainId: args.domainId }, decorators: { path: ["scalarName"], equals: args.scalar.name } },
    select: { id: true, entityId: true, type: true, decorators: true },
  });
  const touched = new Set<string>();
  let updated = 0;
  for (const row of rows) {
    const decorators = (row.decorators ?? {}) as Record<string, unknown>;
    const isElement = row.type === "array";
    const next = applyScalarToField({ type: row.type, decorators }, args.scalar.name, args.scalar, isElement);
    if (next.type === row.type && JSON.stringify(next.decorators) === JSON.stringify(decorators)) continue;
    await tx.field.update({ where: { id: row.id }, data: { type: next.type, decorators: next.decorators as Prisma.InputJsonObject } });
    touched.add(row.entityId);
    updated += 1;
  }
  if (touched.size > 0) await tx.entity.updateMany({ where: { id: { in: [...touched] } }, data: { hasUnpublishedChanges: true } });
  return updated;
}
