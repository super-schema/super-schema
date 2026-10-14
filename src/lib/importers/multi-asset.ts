/**
 * Multi-asset import adapter (Epic 15.5).
 *
 * Maps the format-neutral `MultiEntityImportResult` produced by the Protobuf,
 * Avro and JSON Schema importers onto the `TypeSpecImportResult` shape that the
 * shared multi-asset review screen and `createDomainAssetsFromImportAction`
 * already consume — so every format reuses one review + persist path.
 *
 * Pure functions — no side effects, no I/O.
 */

import type { ImportResult, MultiEntityImportResult, ParsedEntity } from "./types";
import type { TypeSpecImportModel, TypeSpecImportResult } from "./typespec.importer";

/** Assets a document defines (entities + enums + scalars); >1 means multi-asset review. */
export function countImportAssets(doc: MultiEntityImportResult): number {
  return doc.entities.length + doc.enums.length + doc.scalars.length;
}

/**
 * The entity a single-entity import keeps, chosen deterministically:
 * the document's own root when it has one (Avro root record, JSON Schema root
 * object); otherwise the first entity, in document order, that no other entity
 * references (the top of the reference graph); otherwise the first entity.
 */
export function pickRootEntity(doc: MultiEntityImportResult): ParsedEntity {
  const explicit = doc.rootEntityName
    ? doc.entities.find((entity) => entity.name === doc.rootEntityName)
    : undefined;
  if (explicit) return explicit;

  const referenced = new Set<string>();
  for (const entity of doc.entities) {
    for (const field of entity.fields) {
      if (field.referencedEntityName && field.referencedEntityName !== entity.name) {
        referenced.add(field.referencedEntityName);
      }
    }
  }
  return doc.entities.find((entity) => !referenced.has(entity.name)) ?? doc.entities[0];
}

/**
 * Single-entity view of a document (importSchema / bulkImport): the root entity
 * plus the document's warnings and a note naming the sibling entities left out.
 */
export function toSingleEntityImport(doc: MultiEntityImportResult): ImportResult {
  const parsedEntity = pickRootEntity(doc);
  const siblings = doc.entities.filter((entity) => entity !== parsedEntity).map((entity) => entity.name);
  const warnings = [...doc.warnings];
  if (siblings.length > 0) {
    const n = siblings.length;
    warnings.push(
      `${n} additional ${n === 1 ? "entity" : "entities"} (${siblings.join(", ")}) ${n === 1 ? "was" : "were"} not imported — use the multi-asset import`
    );
  }
  return { parsedEntity, warnings };
}

/** Same wording `importSchema` uses for its low-confidence warnings, qualified by entity. */
export function lowConfidenceWarnings(entity: ParsedEntity, qualify: boolean): string[] {
  return entity.fields
    .filter((field) => field.confidence === "low")
    .map(
      (field) =>
        `Field "${qualify ? `${entity.name}.` : ""}${field.name}": low confidence mapping from ${field.originalType} to ${field.type}`
    );
}

function referencedNames(entity: ParsedEntity, known: Set<string>): string[] {
  const names = new Set<string>();
  for (const field of entity.fields) {
    const target = field.referencedEntityName;
    if (target && target !== entity.name && known.has(target)) names.add(target);
  }
  return [...names];
}

export function toAssetImportResult(doc: MultiEntityImportResult): TypeSpecImportResult {
  const known = new Set(doc.entities.map((entity) => entity.name));
  const references = new Map(doc.entities.map((entity) => [entity.name, referencedNames(entity, known)]));

  const referencedBy = new Map<string, string[]>();
  for (const [source, targets] of references) {
    for (const target of targets) {
      referencedBy.set(target, [...(referencedBy.get(target) ?? []), source]);
    }
  }

  const models: TypeSpecImportModel[] = doc.entities.map((entity) => ({
    ...entity,
    referencedModelNames: references.get(entity.name) ?? [],
    referencedByModelNames: referencedBy.get(entity.name) ?? [],
    // "Import all entities": every message / record / definition is an entity by default.
    recommendedAsEntity: true,
  }));

  return {
    sourceFormat: doc.sourceFormat,
    models,
    sharedEnums: doc.enums.map((e) => ({ ...e })),
    customScalars: doc.scalars.map((s) => ({ ...s })),
    unions: [],
    aliases: [],
    decoratorDefinitions: [],
    services: [],
    ...(doc.namespace ? { namespace: doc.namespace } : {}),
    warnings: [...doc.warnings, ...doc.entities.flatMap((entity) => lowConfidenceWarnings(entity, true))],
  };
}
