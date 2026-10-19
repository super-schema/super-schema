// src/services/imported-entities.ts
// The entity loop of the bulk schema import (`createDomainAssetsFromImportAction`), kept in its own light module so the server action
// (session, revalidation, audit-free bulk write) and the AsyncAPI import service (a `ServiceContext`) create entities the very same way.
// No TypeSpec source is written: like every import, the entity is created with its field rows and its source is generated when it is published.
import type { Prisma } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { mapFieldCreateInput } from "@/lib/entity-field-input";
import type { LevelScope } from "@/lib/levels";
import { renameReservedFields, reservedFieldRenamedMessage } from "@/lib/reserved-field-names";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";

export interface ImportedEntityInput {
  name: string;
  description?: string;
  extends?: string;
  /** Model tags from the import (TypeSpec `x-tags`), stored as the entity's metadata.tags. */
  tags?: string[];
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
   * Hears about what was changed without refusing anything: a field whose name the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`) is
   * renamed (`hasOwnProperty` -> `hasOwnProperty_1`) and each rename is reported here. Optional; a caller that has no list of notes still
   * gets the rename.
   */
  note?: (message: string) => void;
  /** Entities created so far, by the name the import gave them (an `extends` resolves through it); every created entity is added. */
  refs: Map<string, { id: string; productId: string }>;
}

/** Every imported asset costs a few registry / pre-check queries inside the transaction, so a large import can outlast Prisma's 5 s interactive-transaction default. */
export const IMPORT_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

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
  for (const entity of args.entities) {
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
    const entityMetadata = {
      ...(entity.tags && entity.tags.length > 0 ? { tags: entity.tags } : {}),
      ...(sourceFormat ? { sourceFormat } : {}),
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
    created.push({ id: row.id, name });
  }
  return created;
}
