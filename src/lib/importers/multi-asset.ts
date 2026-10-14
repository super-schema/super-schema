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

import type { MultiEntityImportResult, ParsedEntity } from "./types";
import type { TypeSpecImportModel, TypeSpecImportResult } from "./typespec.importer";

/** Assets a document defines (entities + enums + scalars); >1 means multi-asset review. */
export function countImportAssets(doc: MultiEntityImportResult): number {
  return doc.entities.length + doc.enums.length + doc.scalars.length;
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
