// src/services/imported-entities.ts
// The entity loop of the bulk schema import (`createDomainAssetsFromImportAction`), kept in its own light module so the server action
// (session, revalidation, audit-free bulk write) and the AsyncAPI import service (a `ServiceContext`) create entities the very same way.
// No TypeSpec source is written: like every import, the entity is created with its field rows and its source is generated when it is published.
import type { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { mapFieldCreateInput } from "@/lib/entity-field-input";
import type { LevelScope } from "@/lib/levels";
import { renameReservedFields, renameReservedNames, reservedFieldRenamedMessage, reservedNameRenamedMessage } from "@/lib/reserved-field-names";
import { isPlainObject } from "@/lib/editable-fields";
import { genericExtensionEntries, setOwn } from "@/lib/compiler/governance-decorators";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";

export interface ImportedEntityInput {
  name: string;
  description?: string;
  extends?: string;
  /** Model tags from the import (TypeSpec `x-tags`), stored as the entity's metadata.tags. */
  tags?: string[];
  /** Vendor extensions of the model (unknown JSON Schema keys etc.), stored flat at metadata.custom.extensions. */
  extensions?: Record<string, unknown>;
  fields: CreateFieldInput[];
}

export interface CreateImportedEntitiesArgs {
  /** In creation order: an entity that `extends` another must come after it (the bulk action sorts them; payload entities never extend). */
  entities: ImportedEntityInput[];
  productScope: LevelScope;
  productId: string;
  ownerId: string;
  /** The format the entities were imported in (`metadata.sourceFormat`); a message's "Auto" representation follows it. Nothing is written when absent. */
  sourceFormat?: string;
  /** True when `name` is free in the entity's line; when it is not, the callee has recorded why (through `skip`) and the entity is left out. */
  isNameFree: (name: string) => Promise<boolean>;
  skip: (message: string) => void;
  /**
   * Hears about what was changed without refusing anything: a field or an entity whose name the AsyncAPI parser cannot read
   * (`PARSER_UNSAFE_KEYS`) is renamed (`hasOwnProperty` -> `hasOwnProperty_1`) and each rename is reported here. Optional; a caller that has
   * no list of notes still gets the rename.
   */
  note?: (message: string) => void;
  /** Entities created so far, by the name the import gave them (an `extends` resolves through it); every created entity is added. */
  refs: Map<string, { id: string; productId: string }>;
}

/** Every imported asset costs a few registry / pre-check queries inside the transaction, so a large import can outlast Prisma's 5 s interactive-transaction default. */
export const IMPORT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

type ImportedField = ImportedEntityInput["fields"][number];

/**
 * The entity-level extensions worth persisting: the payload arrives untyped from the browser, so only a plain object counts (arrays,
 * primitives and null are ignored). `x-tags` / `x-classification` have their own path and stay out; a `__proto__` key is kept as an own data key.
 */
function sanitizeExtensions(raw: unknown): Prisma.InputJsonObject | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of genericExtensionEntries(raw as Record<string, unknown>)) setOwn(out, key, value);
  // The values come from parsed JSON (the browser payload / a JSON Schema document), so the object is JSON by construction: this is
  // where `unknown` is told so, once, for every Prisma `Json` column it is written to.
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonObject) : undefined;
}

/**
 * `{ metadata: { custom: { extensions } } }` for the single-entity creates (the wizard's field preview), `{}` when there is nothing
 * worth storing: the same shape and the same sanitising the bulk import writes, so both paths keep an entity's `x-*` keys.
 */
export function entityExtensionsMetadata(raw: unknown): { metadata?: { custom: { extensions: Prisma.InputJsonObject } } } {
  const extensions = sanitizeExtensions(raw);
  return extensions ? { metadata: { custom: { extensions } } } : {};
}

/** `field` with the entity names it refers to (`referencedEntityName`, `arrayElementType`) replaced by their new names. */
function followRenames(field: ImportedField, renames: ReadonlyMap<string, string>): ImportedField {
  const decorators = field.decorators;
  if (!decorators) return field;
  const reference = typeof decorators.referencedEntityName === "string" ? renames.get(decorators.referencedEntityName.trim()) : undefined;
  const element = typeof decorators.arrayElementType === "string" ? renames.get(decorators.arrayElementType.trim()) : undefined;
  if (reference === undefined && element === undefined) return field;
  return { ...field, decorators: { ...decorators, ...(reference === undefined ? {} : { referencedEntityName: reference }), ...(element === undefined ? {} : { arrayElementType: element }) } };
}

/**
 * The batch with every entity whose name the AsyncAPI parser cannot read renamed (`hasOwnProperty` -> `hasOwnProperty_1`), and everything of
 * the batch that refers to it by name (`extends`, a reference field, an array of it) following. `originals` maps each new name back to the
 * name the import gave it.
 */
function renameReservedEntities(entities: ImportedEntityInput[], note?: (message: string) => void): { entities: ImportedEntityInput[]; originals: Map<string, string> } {
  const { items, renames } = renameReservedNames(entities, (from, to) => note?.(reservedNameRenamedMessage("entity", from, to)));
  if (renames.size === 0) return { entities: items, originals: new Map() };
  return {
    entities: items.map((entity) => ({ ...entity, fields: entity.fields.map((field) => followRenames(field, renames)) })),
    originals: new Map([...renames].map(([from, to]) => [to, from])),
  };
}

/**
 * Creates the entities inside the caller's transaction (which holds the tenant's name lock). Every known conflict is checked before
 * its create and skipped with a message, so no statement that can fail on a known conflict runs inside the interactive transaction
 * (Postgres would abort it). Returns the entities created, in creation order. Anything unexpected throws: the caller's transaction
 * rolls back.
 */
export async function createImportedEntities(tx: Prisma.TransactionClient, args: CreateImportedEntitiesArgs): Promise<Array<{ id: string; name: string }>> {
  const { productScope, productId, ownerId, sourceFormat, refs } = args;
  const created: Array<{ id: string; name: string }> = [];
  // Names are trimmed before BOTH the registry check and the write: the registry compares trimmed names, so an
  // untrimmed stored name ("Foo ") would slip past a later "Foo" and break line uniqueness.
  const { entities, originals } = renameReservedEntities(args.entities, args.note);
  for (const entity of entities) {
    const name = entity.name.trim();
    if (!(await args.isNameFree(name))) continue;

    const reservedMsg = reservedEntitySlugMessage(name);
    if (reservedMsg) {
      args.skip(reservedMsg);
      continue;
    }

    const slug = generateSlug(entity.name);
    const slugTaken = await tx.entity.findFirst({
      where: { slug, productId },
      select: { id: true },
    });
    if (slugTaken) {
      args.skip(`Entity "${entity.name}" already exists — skipped`);
      continue;
    }

    const parentEntityId = entity.extends ? refs.get(entity.extends)?.id : undefined;
    // metadata.sourceFormat records the format the entity was imported in: a message's "Auto" representation follows it
    // (Avro-imported stays Avro). Model tags travel next to it. Nothing is written when neither is known.
    const extensions = sanitizeExtensions(entity.extensions);
    const entityMetadata = {
      ...(entity.tags && entity.tags.length > 0 ? { tags: entity.tags } : {}),
      ...(sourceFormat ? { sourceFormat } : {}),
      ...(extensions ? { custom: { extensions } } : {}),
    };
    const row = await tx.entity.create({
      data: {
        name,
        slug,
        ...productScope,
        description: entity.description ?? "",
        ownerId,
        ...(parentEntityId ? { parentEntityId } : {}),
        ...(Object.keys(entityMetadata).length > 0 ? { metadata: entityMetadata } : {}),
        fields: {
          create: renameReservedFields(entity.fields, (from, to) => args.note?.(reservedFieldRenamedMessage(from, to, name))).map((field, index) => mapFieldCreateInput(field, index)),
        },
      },
    });

    refs.set(entity.name, { id: row.id, productId });
    // whatever else in the import still calls it by the name the file gave it (a service of the same import) finds it too
    const original = originals.get(name);
    if (original !== undefined) refs.set(original, { id: row.id, productId });
    created.push({ id: row.id, name });
  }
  return created;
}
