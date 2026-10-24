/**
 * Builds the `createDomainAssetsFromImportAction` payload from a multi-asset
 * import result and the review-screen selection. Shared by ImportDialog and
 * EntityCreationWizard so every format persists the same way.
 *
 * Pure functions — no side effects, no I/O.
 */

import type {
  BulkImportPayload,
  CreateFieldInput,
} from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { buildDecoratorsFromParsedField } from "./decorator-builder";
import { sanitizeImportedText } from "./text-safety";
import type { ParsedEntity, ParsedField } from "./types";
import type { TypeSpecImportResult } from "./typespec.importer";

/** What the user kept on the multi-asset review screen (indices into the result arrays). */
export interface ImportAssetSelection {
  domainId: string;
  selectedModels: number[];
  selectedEntities: number[];
  selectedEnums: number[];
  selectedScalars: number[];
  selectedUnions: number[];
  selectedServices: number[];
  selectedDecorators: number[];
}

/**
 * The precision and scale the field row gets for a parsed field: the source's own (BigQuery `NUMERIC(12, 2)`, Avro `decimal`), as long
 * as the field is still of the type the importer gave it (a reviewer who changed the type of the row left the decimal behind), else null.
 */
export function decimalFacts(parsed: ParsedField | undefined, currentType: string): { precision: number | null; scale: number | null } {
  if (!parsed || parsed.type !== currentType) return { precision: null, scale: null };
  return { precision: parsed.precision ?? null, scale: parsed.scale ?? null };
}

export function parsedFieldToCreateFieldInput(field: ParsedField): CreateFieldInput {
  return {
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    isKey: field.isKey ?? false,
    description: sanitizeImportedText(field.description ?? ""),
    classification: field.classification ?? null,
    ...decimalFacts(field, field.type),
    decorators: buildDecoratorsFromParsedField(field),
    // An enum field's symbols travel verbatim as its aliases, which the generator prefers; the `A|B` copy in the pattern slot (kept for
    // rows written before) cannot carry an empty symbol or one that contains `|`.
    ...(field.type === "enum" && field.enumValues?.length ? { aliases: [...field.enumValues] } : {}),
    ...(field.fieldNumber != null ? { fieldNumber: field.fieldNumber } : {}),
  };
}

function toModelInput(model: ParsedEntity & { extends?: string }) {
  return {
    name: model.name,
    description: model.description === undefined ? undefined : sanitizeImportedText(model.description),
    extends: model.extends,
    ...(model.extensions && Object.keys(model.extensions).length > 0 ? { extensions: model.extensions } : {}),
    fields: model.fields.map(parsedFieldToCreateFieldInput),
  };
}

/** An entity additionally carries the model's tags (Story 16.6 round trip: `x-tags` → metadata.tags). */
function toEntityInput(model: ParsedEntity & { extends?: string; tags?: string[] }) {
  return {
    ...toModelInput(model),
    ...(model.tags && model.tags.length > 0 ? { tags: model.tags } : {}),
  };
}

export function buildImportAssetsPayload(
  result: TypeSpecImportResult,
  selection: ImportAssetSelection
): Omit<BulkImportPayload, "domainId" | "productId"> {
  return {
    namespace: result.namespace,
    sourceFormat: result.sourceFormat ?? "typespec",
    models: selection.selectedModels.map((idx) => toModelInput(result.models[idx])),
    entities: selection.selectedEntities.map((idx) => toEntityInput(result.models[idx])),
    sharedEnums: selection.selectedEnums.map((idx) => result.sharedEnums[idx]),
    customScalars: selection.selectedScalars.map((idx) => result.customScalars[idx]),
    unionTypes: selection.selectedUnions.map((idx) => result.unions[idx]),
    services: selection.selectedServices.map((idx) => result.services[idx]),
    decoratorDefinitions: selection.selectedDecorators.map((idx) => result.decoratorDefinitions[idx]),
  };
}
