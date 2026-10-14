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

export function parsedFieldToCreateFieldInput(field: ParsedField): CreateFieldInput {
  return {
    name: field.name,
    type: field.type,
    nullable: field.nullable,
    isKey: field.isKey ?? false,
    description: field.description ?? "",
    classification: field.classification ?? null,
    precision: null,
    scale: null,
    decorators: buildDecoratorsFromParsedField(field),
  };
}

function toModelInput(model: ParsedEntity & { extends?: string }) {
  return {
    name: model.name,
    description: model.description,
    extends: model.extends,
    fields: model.fields.map(parsedFieldToCreateFieldInput),
  };
}

export function buildImportAssetsPayload(
  result: TypeSpecImportResult,
  selection: ImportAssetSelection
): Omit<BulkImportPayload, "domainId" | "productId"> {
  return {
    namespace: result.namespace,
    models: selection.selectedModels.map((idx) => toModelInput(result.models[idx])),
    entities: selection.selectedEntities.map((idx) => toModelInput(result.models[idx])),
    sharedEnums: selection.selectedEnums.map((idx) => result.sharedEnums[idx]),
    customScalars: selection.selectedScalars.map((idx) => result.customScalars[idx]),
    unionTypes: selection.selectedUnions.map((idx) => result.unions[idx]),
    services: selection.selectedServices.map((idx) => result.services[idx]),
    decoratorDefinitions: selection.selectedDecorators.map((idx) => result.decoratorDefinitions[idx]),
  };
}
