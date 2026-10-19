// src/services/events/import-payload-entities.ts
// The entities an AsyncAPI import creates for the payloads and headers of its messages: how an importer's result becomes entities, how
// their names are made unique, the one transaction that writes them and the delete that takes them back. The write itself is
// `createImportedEntities` (src/services/imported-entities.ts), the entity loop of the bulk schema import: no TypeSpec source is
// generated here, the entities are created with their field rows exactly like every other import.
import type { PrismaClient } from "@/generated/prisma/client";
import type { CreateFieldInput } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { resolveScope } from "@/lib/asset-scope";
import { dbErrorResult } from "@/lib/db-error";
import { pascalName, type ExtractedPayload, type ImportWarning } from "@/lib/events/import";
import { parseAvroDocument } from "@/lib/importers/avro.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { pickRootEntity } from "@/lib/importers/multi-asset";
import { parseProtobufDocument } from "@/lib/importers/protobuf.importer";
import type { MultiEntityImportResult, ParsedField } from "@/lib/importers/types";
import { validateScope, type LevelScope } from "@/lib/levels";
import { renameReservedFields, reservedFieldRenamedMessage } from "@/lib/reserved-field-names";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";
import { deleteEntity } from "@/services/entity.service";
import { MAX_FIELD_RENAME_WARNINGS, MAX_NAME_ATTEMPTS, MAX_NOTES_PER_PAYLOAD, MAX_REQUESTED_NAME, boundText } from "@/services/events/import-limits";
import { createImportedEntities, IMPORT_TRANSACTION_OPTIONS, type ImportedEntityInput } from "@/services/imported-entities";
import { assertNameAvailable } from "@/services/name-registry.service";
import { ServiceErrorRejection } from "@/services/scoped-create.service";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

type SchemaFormat = "json-schema" | "avro" | "protobuf";
export type PlannedFormat = SchemaFormat | "placeholder";

interface PlannedEntity {
  /** What the entity should be called: the message's name for a JSON Schema root, the importer's name for everything else, made a usable entity name. */
  requestedName: string;
  /** The importer's own name for it: what `referencedEntityName` of the payload's other entities says. */
  sourceName: string;
  description: string;
  fields: ParsedField[];
}

/** The entities of one payload or headers schema, the root FIRST. */
export interface PlannedPayload {
  /** `${messageKey}:payload` / `${messageKey}:headers`: the key the mapper looks the pin up by. */
  pinKey: string;
  sourcePointer: string;
  format: PlannedFormat;
  entities: PlannedEntity[];
}

const IMPORTERS: Record<SchemaFormat, (content: string) => Result<MultiEntityImportResult>> = {
  "json-schema": parseJsonSchemaDocument,
  avro: parseAvroDocument,
  protobuf: parseProtobufDocument,
};

const VALID_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** A name the registry, the slug and the generators can all live with: letters, digits, `.`, `_`, `-`, starting with a letter, short enough for a suffix. */
function usableName(name: string): string {
  const trimmed = name.trim();
  return VALID_NAME.test(trimmed) && trimmed.length <= MAX_REQUESTED_NAME ? trimmed : pascalName(trimmed);
}

/** The text a format's importer reads: Avro and JSON Schema arrive as parsed objects, Protobuf as `.proto` source. */
const contentOf = (raw: unknown): string => (typeof raw === "string" ? raw : JSON.stringify(raw));

/**
 * The entities of every extracted payload (and headers) schema, each root first. Per payload:
 * - JSON Schema / Avro / Protobuf: the format's importer's entities (the root and the definitions). A JSON Schema root is named after
 *   its message (a schema `title` is a label, often shared or missing); an Avro record / Protobuf message keeps its own name (it is the
 *   wire name).
 * - anything else (an unsupported format, no payload, an importer that fails on it): ONE entity with no fields, so the message still
 *   has something to pin. Headers have no placeholder: a headers schema that cannot be imported is left out.
 * The mapper already reports unsupported and missing schemas; an importer that fails is reported here, with its own reason.
 *
 * An importer runs once per DISTINCT schema (format + text): messages that share a schema share one parse (its notes are reported once,
 * for the first message). The caller has already bounded what is handed over (`checkPayloadLimits`): an importer cannot be interrupted.
 */
export function planPayloadEntities(payloads: readonly ExtractedPayload[], fileName?: string): { plans: PlannedPayload[]; warnings: ImportWarning[] } {
  const plans: PlannedPayload[] = [];
  const warnings: ImportWarning[] = [];
  const origin = fileName ? ` (imported from ${fileName})` : "";
  const parsedBefore = new Map<string, Result<MultiEntityImportResult>>();
  for (const payload of payloads) {
    const pinKey = `${payload.messageKey}:${payload.role}`;
    const placeholder = (): PlannedPayload => {
      const requestedName = usableName(payload.suggestedName);
      const description = `Stands in for the payload of "${payload.messageKey}"${origin}: describe its fields here.`;
      return { pinKey, sourcePointer: payload.sourcePointer, format: "placeholder", entities: [{ requestedName, sourceName: requestedName, description, fields: [] }] };
    };

    if (payload.format === "unsupported" || payload.format === "none") {
      if (payload.role === "payload") plans.push(placeholder());
      continue;
    }
    const content = contentOf(payload.raw);
    const memoKey = `${payload.format}\u0000${content}`;
    const known = parsedBefore.get(memoKey);
    const parsed = known ?? IMPORTERS[payload.format](content);
    if (known === undefined) parsedBefore.set(memoKey, parsed);
    if (!parsed.success || parsed.data.entities.length === 0) {
      const reason = parsed.success ? "it defines no entity" : boundText(parsed.error.message);
      const outcome = payload.role === "payload" ? "an entity with no fields stands in for it, describe it there" : "they were left out of the import";
      warnings.push({ pointer: payload.sourcePointer, code: "UNSUPPORTED_PAYLOAD_FORMAT", message: `The ${payload.role} of "${payload.messageKey}" could not be imported (${reason}); ${outcome}` });
      if (payload.role === "payload") plans.push(placeholder());
      continue;
    }

    const doc = parsed.data;
    const root = pickRootEntity(doc);
    const entities = [root, ...doc.entities.filter((entity) => entity !== root)].map((entity): PlannedEntity => {
      const named = entity === root && payload.format === "json-schema" ? payload.suggestedName : entity.name;
      return { requestedName: usableName(named), sourceName: entity.name, description: entity.description ?? "", fields: entity.fields };
    });
    plans.push({ pinKey, sourcePointer: payload.sourcePointer, format: payload.format, entities });

    if (known === undefined) {
      for (const note of doc.warnings.slice(0, MAX_NOTES_PER_PAYLOAD)) {
        warnings.push({ pointer: payload.sourcePointer, code: "DROPPED_CONSTRUCT", message: `The ${payload.role} of "${payload.messageKey}": ${boundText(note)}` });
      }
      if (doc.warnings.length > MAX_NOTES_PER_PAYLOAD) {
        warnings.push({ pointer: payload.sourcePointer, code: "DROPPED_CONSTRUCT", message: `The ${payload.role} of "${payload.messageKey}": ${doc.warnings.length - MAX_NOTES_PER_PAYLOAD} more ${doc.warnings.length - MAX_NOTES_PER_PAYLOAD === 1 ? "note was" : "notes were"} left out of this report` });
      }
    }
  }
  return { plans, warnings };
}

// ── names ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NameAllocator {
  /** `requested`, or `requested2`, `requested3`, … — the first one free in the product's line, never one this allocator handed out before. */
  allocate(requested: string, kind: "entity" | "event"): Promise<Result<string>>;
}

/**
 * Hands out names that are free in the product's uniqueness line (`assertNameAvailable`: entities, enums, scalars, unions, APIs, traits
 * and events share it, case-insensitively), unique among themselves, and for entities also free as a URL slug of the product and not a
 * reserved route. Reads only; the write that follows re-checks under the tenant's lock.
 */
export async function createNameAllocator(db: PrismaClient, scope: LevelScope): Promise<Result<NameAllocator>> {
  let slugs: Set<string>;
  try {
    const rows = await db.entity.findMany({ where: { productId: scope.productId }, select: { slug: true } });
    slugs = new Set(rows.map((row) => row.slug));
  } catch (e) {
    return dbErrorResult("createNameAllocator", e);
  }
  const names = new Set<string>();
  return ok({
    async allocate(requested, kind) {
      for (let n = 1; n <= MAX_NAME_ATTEMPTS; n += 1) {
        const suffix = n === 1 ? "" : String(n);
        const candidate = `${requested.slice(0, 128 - suffix.length)}${suffix}`;
        const slug = generateSlug(candidate);
        const unclaimed = !names.has(candidate.toLowerCase()) && (kind === "event" || (slug !== "" && !slugs.has(slug) && reservedEntitySlugMessage(candidate) === null));
        if (!unclaimed) continue;
        const registry = await assertNameAvailable(db, { name: candidate, ...scope });
        if (!registry.success) {
          if (registry.error.code === "NAME_CONFLICT") continue;
          return registry;
        }
        names.add(candidate.toLowerCase());
        if (kind === "entity") slugs.add(slug);
        return ok(candidate);
      }
      return err({
        code: "CONFLICT", message: `No free name was found for "${requested}" (${requested}2 to ${requested}${MAX_NAME_ATTEMPTS} are all taken).`,
        suggestedFix: "Rename the message in the document, or remove the entities you no longer use, and import again.",
      });
    },
  });
}

export interface ResolvedEntity {
  requestedName: string;
  name: string;
  renamed: boolean;
  fields: number;
  format: PlannedFormat;
  /** The entity as the bulk-import logic takes it: the final name, references already pointing at final names. */
  input: ImportedEntityInput;
}
export interface ResolvedPayload {
  pinKey: string;
  format: PlannedFormat;
  /** Root first. */
  entities: ResolvedEntity[];
}

/**
 * Field names whose URL slugs (`generateSlug`) are all different: `fields` has a unique (entity, slug) and a unique (entity, name), and
 * importers can return `a b` / `a-b`, or names with no Latin letters at all (their slug is empty). The first field of a slug keeps its
 * name; a later one with the same slug gets a number (`a-b2`). `onRename` hears about each one. A reserved name is renamed first
 * (`onReservedRename`).
 */
function uniqueFieldNames(
  allFields: CreateFieldInput[], onRename: (from: string, to: string) => void, onReservedRename: (from: string, to: string) => void,
): CreateFieldInput[] {
  // A name the AsyncAPI parser cannot read (`hasOwnProperty`, see `PARSER_UNSAFE_KEYS`) becomes `hasOwnProperty_1`: an Avro or Protobuf field
  // name is a VALUE in the document, so it passes the importer's source check, and it would become a payload property that crashes the parser.
  const fields = renameReservedFields(allFields, onReservedRename);
  const slugs = new Set<string>();
  const nextNumber = new Map<string, number>(); // per colliding slug: where to go on, so 2,000 fields of empty slug stay linear
  return fields.map((field) => {
    let name = field.name;
    let slug = generateSlug(name);
    if (slugs.has(slug)) {
      const collided = slug;
      let n = nextNumber.get(collided) ?? 2;
      for (; ; n += 1) {
        name = `${field.name}${n}`;
        slug = generateSlug(name);
        if (!slugs.has(slug)) break;
      }
      nextNumber.set(collided, n + 1);
      onRename(field.name, name);
    }
    slugs.add(slug);
    return name === field.name ? field : { ...field, name };
  });
}

/**
 * The final name of every planned entity. Roots (what messages pin) are named first, in message order, so a definition that shares a
 * message's name is the one that gets the suffix; then the definitions. References between the entities of one payload are rewritten
 * to the final names. A name that changed is reported (`ENTITY_RENAMED`), and so is a field whose slug collided with an earlier field's
 * (`SANITIZED_VALUE`, at most `MAX_FIELD_RENAME_WARNINGS` of them and one summary).
 */
export async function resolveEntityNames(plans: readonly PlannedPayload[], allocator: NameAllocator): Promise<Result<{ payloads: ResolvedPayload[]; warnings: ImportWarning[] }>> {
  const finalNames = new Map<PlannedEntity, string>();
  const warnings: ImportWarning[] = [];
  const ordered = [
    ...plans.map((plan) => ({ plan, entity: plan.entities[0] })),
    ...plans.flatMap((plan) => plan.entities.slice(1).map((entity) => ({ plan, entity }))),
  ];
  for (const { plan, entity } of ordered) {
    const allocated = await allocator.allocate(entity.requestedName, "entity");
    if (!allocated.success) return allocated;
    finalNames.set(entity, allocated.data);
    if (allocated.data !== entity.requestedName) {
      warnings.push({
        pointer: plan.sourcePointer, code: "ENTITY_RENAMED",
        message: `The name "${entity.requestedName}" is already used in this product (or is reserved), so the entity is named "${allocated.data}"`,
      });
    }
  }
  let renamedFields = 0;
  let renamedReserved = 0;
  const payloads = plans.map((plan): ResolvedPayload => {
    const renames = new Map(plan.entities.map((entity) => [entity.sourceName, finalNames.get(entity) as string]));
    return {
      pinKey: plan.pinKey, format: plan.format,
      entities: plan.entities.map((entity): ResolvedEntity => {
        const name = finalNames.get(entity) as string;
        const fields = entity.fields.map((field) => {
          const target = field.referencedEntityName === undefined ? undefined : renames.get(field.referencedEntityName);
          return target === undefined ? field : { ...field, referencedEntityName: target };
        });
        const inputs = uniqueFieldNames(fields.map(parsedFieldToCreateFieldInput), (from, to) => {
          renamedFields += 1;
          if (renamedFields <= MAX_FIELD_RENAME_WARNINGS) {
            warnings.push({
              pointer: plan.sourcePointer, code: "SANITIZED_VALUE",
              message: `Entity "${boundText(name, 100)}": the field "${boundText(from, 100)}" has the same URL slug as an earlier field, so it is named "${boundText(to, 110)}"`,
            });
          }
        }, (from, to) => {
          renamedReserved += 1;
          if (renamedReserved <= MAX_FIELD_RENAME_WARNINGS) {
            warnings.push({ pointer: plan.sourcePointer, code: "SANITIZED_VALUE", message: reservedFieldRenamedMessage(boundText(from, 100), boundText(to, 110), boundText(name, 100)) });
          }
        });
        return {
          requestedName: entity.requestedName, name, renamed: name !== entity.requestedName, fields: entity.fields.length, format: plan.format,
          input: { name, description: entity.description, fields: inputs },
        };
      }),
    };
  });
  if (renamedFields > MAX_FIELD_RENAME_WARNINGS) {
    warnings.push({ pointer: "", code: "SANITIZED_VALUE", message: renamedFields - MAX_FIELD_RENAME_WARNINGS === 1 ? "1 more field was renamed because its URL slug collided; it is not listed" : `${renamedFields - MAX_FIELD_RENAME_WARNINGS} more fields were renamed because their URL slugs collided; they are not listed` });
  }
  if (renamedReserved > MAX_FIELD_RENAME_WARNINGS) {
    const more = renamedReserved - MAX_FIELD_RENAME_WARNINGS;
    warnings.push({ pointer: "", code: "SANITIZED_VALUE", message: more === 1 ? "1 more field was renamed because its name is reserved; it is not listed" : `${more} more fields were renamed because their names are reserved; they are not listed` });
  }
  return ok({ payloads, warnings });
}

// ── writing and taking back ────────────────────────────────────────────────────────────────────────────────────────────

export interface CreatedPayloadEntities {
  /** `pinKey` → the id of the payload's root entity (what the message pins). */
  roots: Map<string, string>;
  /** Every entity created, in creation order. */
  created: Array<{ id: string; name: string }>;
}

/**
 * Creates the entities of every payload in ONE transaction under the tenant's name lock: all of them or none. Each payload is
 * written by `createImportedEntities` with its own `sourceFormat` (a placeholder has none). The names were resolved earlier, so a
 * skipped entity can only mean that someone took the name since: the whole import is then refused as a retryable CONFLICT.
 */
export async function createPayloadEntities(productId: string, payloads: readonly ResolvedPayload[], ctx: ServiceContext): Promise<Result<CreatedPayloadEntities>> {
  try {
    return await ctx.prisma.$transaction(async (tx) => {
      const resolved = await resolveScope(tx, { level: "PRODUCT", productId });
      if (!resolved.success) throw new ServiceErrorRejection(resolved.error);
      const scope = resolved.data;
      const placed = validateScope("entity", scope);
      if (!placed.success) throw new ServiceErrorRejection(placed.error);
      // Serialize name checks + writes for this tenant (spec §4.3).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scope.tenantId}))`;

      const skipped: string[] = [];
      const refs = new Map<string, { id: string; productId: string }>();
      const out: CreatedPayloadEntities = { roots: new Map(), created: [] };
      for (const payload of payloads) {
        const created = await createImportedEntities(tx, {
          entities: payload.entities.map((entity) => entity.input), productScope: scope, productId, ownerId: ctx.userId,
          sourceFormat: payload.format === "placeholder" ? undefined : payload.format,
          isNameFree: async (name) => {
            const free = await assertNameAvailable(tx, { name, ...scope });
            if (free.success) return true;
            if (free.error.code !== "NAME_CONFLICT") throw new ServiceErrorRejection(free.error);
            skipped.push(free.error.message);
            return false;
          },
          skip: (message) => skipped.push(message),
          refs,
        });
        if (skipped.length > 0) {
          throw new ServiceErrorRejection({
            code: "CONFLICT", message: `A name this import needs was taken while it ran (${skipped[0]}); nothing was imported.`,
            suggestedFix: "Import again.", details: { skipped },
          });
        }
        out.created.push(...created);
        out.roots.set(payload.pinKey, created[0].id);
      }
      return ok(out);
    }, IMPORT_TRANSACTION_OPTIONS);
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    return dbErrorResult("createPayloadEntities", e);
  }
}

export interface UndeletedEntity { id: string; name: string; code: string; message: string }

/**
 * Takes created entities back, newest first, through the guarded delete (`deleteEntity`: nothing that is still referenced goes).
 * An entity that is already gone (`NOT_FOUND`: something else removed it) is what the rollback wants, not a leftover. Never throws;
 * returns the ones that could NOT be deleted so the caller can say so.
 */
export async function deleteCreatedEntities(created: ReadonlyArray<{ id: string; name: string }>, ctx: ServiceContext): Promise<UndeletedEntity[]> {
  const failures: UndeletedEntity[] = [];
  for (const entity of [...created].reverse()) {
    try {
      const deleted = await deleteEntity(entity.id, ctx);
      if (!deleted.success && deleted.error.code !== "NOT_FOUND") failures.push({ ...entity, code: deleted.error.code, message: deleted.error.message });
    } catch (e: unknown) {
      console.error(`[deleteCreatedEntities] ${entity.id}`, e);
      failures.push({ ...entity, code: "INTERNAL_ERROR", message: "The entity could not be deleted" });
    }
  }
  return failures;
}
