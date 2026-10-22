"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Box,
  List,
  Hash,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Globe,
  Tag,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import type { ImportAssetSelection } from "@/lib/importers/import-payload";
import { IMPORTED_ENTITY_FALLBACK_NAME, type ImportFormat } from "@/lib/importers/types";
import {
  MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE,
  ParsedEntityDetails,
  ParsedFieldDetails,
  ParsedFieldSummaryBadges,
} from "./ParsedFieldDetails";

/**
 * Multi-asset import review, shared by every format that can define several
 * assets in one document (TypeSpec, OpenAPI, Protobuf, Avro, JSON Schema).
 */
export type TypeSpecImportSelection = ImportAssetSelection;

const FORMAT_LABEL: Record<ImportFormat, string> = {
  typespec: "TypeSpec",
  openapi: "OpenAPI",
  protobuf: "Protobuf",
  avro: "Avro",
  "json-schema": "JSON Schema",
  "bigquery-ddl": "BigQuery DDL",
};

interface TypeSpecImportReviewScreenProps {
  importResult: TypeSpecImportResult;
  domains: { id: string; name: string }[];
  suggestedDomainName?: string;
  onConfirm: (selection: TypeSpecImportSelection) => void;
  onCancel: () => void;
}

function SectionHeader({
  title,
  icon: Icon,
  count,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
}) {
  return (
    <h4 className="text-body-small font-medium text-foreground flex items-center gap-1.5 mb-2">
      <Icon className="w-3.5 h-3.5" />
      {title} ({count})
    </h4>
  );
}

export function TypeSpecImportReviewScreen({
  importResult,
  domains,
  suggestedDomainName,
  onConfirm,
  onCancel,
}: TypeSpecImportReviewScreenProps) {
  const suggestedDomain = suggestedDomainName
    ? domains.find((domain) => domain.name.toLowerCase() === suggestedDomainName.toLowerCase())
    : null;

  const [selectedDomainId, setSelectedDomainId] = useState(
    suggestedDomain?.id ?? domains[0]?.id ?? ""
  );
  const [selectedModels, setSelectedModels] = useState<Set<number>>(
    new Set(importResult.models.map((_, index) => index))
  );
  const [selectedEntities, setSelectedEntities] = useState<Set<number>>(
    new Set(
      importResult.models
        .map((model, index) => (model.recommendedAsEntity ? index : null))
        .filter((value): value is number => value !== null)
    )
  );
  const [selectedEnums, setSelectedEnums] = useState<Set<number>>(
    new Set(importResult.sharedEnums.map((_, index) => index))
  );
  const [selectedScalars, setSelectedScalars] = useState<Set<number>>(
    new Set(importResult.customScalars.map((_, index) => index))
  );
  const [selectedUnions, setSelectedUnions] = useState<Set<number>>(
    new Set(importResult.unions.map((_, index) => index))
  );
  const [selectedServices, setSelectedServices] = useState<Set<number>>(
    new Set(importResult.services.map((_, index) => index))
  );
  const [selectedDecorators, setSelectedDecorators] = useState<Set<number>>(
    new Set(importResult.decoratorDefinitions.map((_, index) => index))
  );
  const [expandedModels, setExpandedModels] = useState<Set<number>>(new Set());
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const entityNames = useMemo(
    () => new Set(importResult.models.map((model) => model.name)),
    [importResult.models]
  );

  function toggleFieldExpand(key: string) {
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelection(
    index: number,
    selected: Set<number>,
    setSelected: (value: Set<number>) => void
  ) {
    const next = new Set(selected);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setSelected(next);
  }

  function toggleModel(index: number) {
    const next = new Set(selectedModels);
    if (next.has(index)) {
      next.delete(index);
      if (selectedEntities.has(index)) {
        const nextEntities = new Set(selectedEntities);
        nextEntities.delete(index);
        setSelectedEntities(nextEntities);
      }
    } else {
      next.add(index);
    }
    setSelectedModels(next);
  }

  function toggleEntity(index: number) {
    if (!selectedModels.has(index)) return;
    toggleSelection(index, selectedEntities, setSelectedEntities);
  }

  function toggleModelExpand(index: number) {
    toggleSelection(index, expandedModels, setExpandedModels);
  }

  const totalSelected = useMemo(
    () =>
      selectedModels.size +
      selectedEntities.size +
      selectedEnums.size +
      selectedScalars.size +
      selectedUnions.size +
      selectedServices.size +
      selectedDecorators.size,
    [
      selectedDecorators.size,
      selectedEntities.size,
      selectedEnums.size,
      selectedModels.size,
      selectedScalars.size,
      selectedServices.size,
      selectedUnions.size,
    ]
  );

  // A model registered as an entity that still carries the importer placeholder name must not be created under it: the confirm
  // button waits until the model is renamed in the source or unregistered (no inline rename: the payload is index based).
  const unnamedEntityIndexes = importResult.models
    .map((model, index) => (model.name === IMPORTED_ENTITY_FALLBACK_NAME && selectedModels.has(index) && selectedEntities.has(index) ? index : -1))
    .filter((index) => index >= 0);
  const needsEntityName = unnamedEntityIndexes.length > 0;

  function handleConfirm() {
    onConfirm({
      domainId: selectedDomainId,
      selectedModels: [...selectedModels],
      selectedEntities: [...selectedEntities],
      selectedEnums: [...selectedEnums],
      selectedScalars: [...selectedScalars],
      selectedUnions: [...selectedUnions],
      selectedServices: [...selectedServices],
      selectedDecorators: [...selectedDecorators],
    });
  }

  const danglingCount = importResult.models.reduce(
    (n, model) => n + model.fields.filter((f) => f.danglingRef).length,
    0,
  );

  return (
    <div className="space-y-space-4" data-testid="typespec-import-review">
      <div>
        <h3 className="text-heading-3 text-foreground">
          Review {FORMAT_LABEL[importResult.sourceFormat ?? "typespec"]} Import
        </h3>
        <p className="text-caption text-muted-foreground mt-1">
          {importResult.models.length} model(s), {importResult.sharedEnums.length} enum(s),{" "}
          {importResult.customScalars.length} scalar(s), {importResult.unions.length} union(s),{" "}
          {importResult.services.length} API service(s), {importResult.decoratorDefinitions.length} decorator definition(s)
          {importResult.namespace && (
            <span className="ml-1">
              from namespace <span className="text-foreground font-medium">{importResult.namespace}</span>
            </span>
          )}
        </p>
      </div>

      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Target Domain</label>
        <select
          value={selectedDomainId}
          onChange={(event) => setSelectedDomainId(event.target.value)}
          className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name}
              {suggestedDomain?.id === domain.id ? " (from namespace)" : ""}
            </option>
          ))}
        </select>
      </div>

      {danglingCount > 0 && (
        <div
          role="status"
          data-testid="import-dangling-banner"
          className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-foreground"
        >
          {danglingCount} reference(s) could not be loaded — they will stay as dangling references. Imported
          entities are created as drafts.
        </div>
      )}

      {importResult.warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1">
          {importResult.warnings.map((warning, index) => (
            <p key={index} className="text-caption text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}

      {importResult.models.length > 0 && (
        <div>
          <SectionHeader title="Models" icon={Box} count={importResult.models.length} />
          <div className="space-y-1">
            {importResult.models.map((model, index) => (
              <div key={model.name} className="rounded-lg border border-border/50" data-testid={`import-model-${model.name}`}>
                <div className="flex items-start gap-2 px-3 py-2">
                  <input
                    aria-label={`${model.name} model`}
                    type="checkbox"
                    checked={selectedModels.has(index)}
                    onChange={() => toggleModel(index)}
                    className="rounded mt-0.5"
                  />
                  <button
                    type="button"
                    onClick={() => toggleModelExpand(index)}
                    className="p-0.5 rounded hover:bg-accent mt-0.5"
                  >
                    {expandedModels.has(index) ? (
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body-small font-medium text-foreground">{model.name}</span>
                      <Badge variant="secondary" className="text-[10px] h-4">
                        {model.fields.length} fields
                      </Badge>
                      {model.recommendedAsEntity && (
                        <Badge variant="outline" className="text-[10px] h-4">
                          Recommended Entity
                        </Badge>
                      )}
                      {model.extends && (
                        <Badge variant="outline" className="text-[10px] h-4 font-mono">
                          extends {model.extends}
                        </Badge>
                      )}
                    </div>
                    {model.description && (
                      <p className="text-caption text-muted-foreground mt-1">{model.description}</p>
                    )}
                    {(model.referencedModelNames.length > 0 || model.referencedByModelNames.length > 0) && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {model.referencedModelNames.length > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            uses {model.referencedModelNames.join(", ")}
                          </span>
                        )}
                        {model.referencedByModelNames.length > 0 && (
                          <span className="text-[10px] text-muted-foreground">
                            referenced by {model.referencedByModelNames.join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap pt-0.5">
                    <input
                      aria-label={`${model.name} entity`}
                      type="checkbox"
                      checked={selectedEntities.has(index)}
                      disabled={!selectedModels.has(index)}
                      onChange={() => toggleEntity(index)}
                      className="rounded"
                    />
                    Register as entity
                  </label>
                </div>

                {/* Always in the DOM (hidden while the model is collapsed): nothing the importer found is withheld. */}
                <div className="px-10 pb-3 space-y-1" hidden={!expandedModels.has(index)}>
                  <ParsedEntityDetails entity={model} showUsed={false} />
                  {model.fields.map((field) => {
                    const fieldKey = `${model.name}::${field.name}`;
                    const open = expandedFields.has(fieldKey);
                    return (
                      <div key={fieldKey} data-testid={`import-field-${model.name}-${field.name}`}>
                        <div className="text-caption text-muted-foreground flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleFieldExpand(fieldKey)}
                            aria-expanded={open}
                            aria-label={`${open ? "Hide" : "Show"} details of ${model.name}.${field.name}`}
                            className="p-0.5 rounded hover:bg-accent"
                          >
                            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          </button>
                          <span className="font-mono">{field.name}</span>
                          <span className="text-muted-foreground/50">{field.type}</span>
                          <ParsedFieldSummaryBadges field={field} entityNames={entityNames} />
                        </div>
                        <div className="ml-6">
                          {(model.fields.length <= MOUNT_DETAILS_ONLY_WHEN_EXPANDED_ABOVE || open) && (
                            <ParsedFieldDetails field={field} entityNames={entityNames} collapsed={!open} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {importResult.sharedEnums.length > 0 && (
        <div>
          <SectionHeader title="Enums" icon={List} count={importResult.sharedEnums.length} />
          <div className="space-y-1">
            {importResult.sharedEnums.map((sharedEnum, index) => (
              <div key={sharedEnum.name} className="rounded-lg border border-border/50 px-3 py-2" data-testid={`import-enum-${sharedEnum.name}`}>
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${sharedEnum.name} enum`}
                    type="checkbox"
                    checked={selectedEnums.has(index)}
                    onChange={() => toggleSelection(index, selectedEnums, setSelectedEnums)}
                    className="rounded"
                  />
                  <span className="text-body-small font-medium text-foreground">{sharedEnum.name}</span>
                  <span className="text-caption text-muted-foreground">{sharedEnum.values.join(", ")}</span>
                </div>
                {sharedEnum.description && (
                  <p className="ml-6 mt-1 text-caption text-muted-foreground">{sharedEnum.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {importResult.customScalars.length > 0 && (
        <div>
          <SectionHeader title="Custom Scalars" icon={Hash} count={importResult.customScalars.length} />
          <div className="space-y-1">
            {importResult.customScalars.map((scalar, index) => (
              <div key={scalar.name} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${scalar.name} scalar`}
                    type="checkbox"
                    checked={selectedScalars.has(index)}
                    onChange={() => toggleSelection(index, selectedScalars, setSelectedScalars)}
                    className="rounded"
                  />
                  <span className="text-body-small font-medium text-foreground">{scalar.name}</span>
                  <span className="text-caption text-muted-foreground">extends {scalar.baseType}</span>
                  {scalar.format && (
                    <Badge variant="outline" className="text-[9px] h-3.5 font-mono">
                      format: {scalar.format}
                    </Badge>
                  )}
                  {scalar.pattern && (
                    <Badge variant="outline" className="text-[9px] h-3.5 font-mono">
                      pattern: {scalar.pattern}
                    </Badge>
                  )}
                </div>
                {scalar.description && (
                  <p className="ml-6 mt-1 text-caption text-muted-foreground">{scalar.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {importResult.unions.length > 0 && (
        <div>
          <SectionHeader title="Unions" icon={GitBranch} count={importResult.unions.length} />
          <div className="space-y-1">
            {importResult.unions.map((unionType, index) => (
              <div key={unionType.name} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${unionType.name} union`}
                    type="checkbox"
                    checked={selectedUnions.has(index)}
                    onChange={() => toggleSelection(index, selectedUnions, setSelectedUnions)}
                    className="rounded"
                  />
                  <span className="text-body-small font-medium text-foreground">{unionType.name}</span>
                  <span className="text-caption text-muted-foreground">{unionType.memberTypes.join(" | ")}</span>
                </div>
                {unionType.description && (
                  <p className="ml-6 mt-1 text-caption text-muted-foreground">{unionType.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {importResult.services.length > 0 && (
        <div>
          <SectionHeader title="APIs" icon={Globe} count={importResult.services.length} />
          <div className="space-y-1">
            {importResult.services.map((service, index) => (
              <div key={service.name} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${service.name} api`}
                    type="checkbox"
                    checked={selectedServices.has(index)}
                    onChange={() => toggleSelection(index, selectedServices, setSelectedServices)}
                    className="rounded"
                  />
                  <span className="text-body-small font-medium text-foreground">{service.name}</span>
                  <Badge variant="secondary" className="text-[10px] h-4">
                    {service.operations.length} ops
                  </Badge>
                  <Badge variant="outline" className="text-[10px] h-4 uppercase">
                    {service.source === "interface" ? "interface" : "standalone ops"}
                  </Badge>
                  <span className="text-caption text-muted-foreground font-mono">{service.basePath}</span>
                </div>
                {service.description && (
                  <p className="ml-6 mt-1 text-caption text-muted-foreground">{service.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {importResult.decoratorDefinitions.length > 0 && (
        <div>
          <SectionHeader title="Decorator Definitions" icon={Tag} count={importResult.decoratorDefinitions.length} />
          <div className="space-y-1">
            {importResult.decoratorDefinitions.map((decorator, index) => (
              <div key={decorator.name} className="rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${decorator.name} decorator`}
                    type="checkbox"
                    checked={selectedDecorators.has(index)}
                    onChange={() =>
                      toggleSelection(index, selectedDecorators, setSelectedDecorators)
                    }
                    className="rounded"
                  />
                  <span className="text-body-small font-medium text-foreground">{decorator.name}</span>
                  {decorator.targetTypes.length > 0 && (
                    <span className="text-caption text-muted-foreground">
                      targets {decorator.targetTypes.join(" | ")}
                    </span>
                  )}
                </div>
                <p className="ml-6 mt-1 text-caption text-muted-foreground font-mono">
                  ({decorator.signature})
                </p>
                {decorator.description && (
                  <p className="ml-6 mt-1 text-caption text-muted-foreground">{decorator.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-space-3 border-t border-border/50">
        <div className="flex flex-col gap-0.5">
          <span className="text-caption text-muted-foreground">
          {totalSelected} asset record(s) selected
        </span>
          {needsEntityName && (
            <span className="text-caption text-warning" data-testid="needs-entity-name">
              Give this entity a name: &ldquo;{IMPORTED_ENTITY_FALLBACK_NAME}&rdquo; is a placeholder. Add a title to the source, or untick Register as entity.
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedDomainId || totalSelected === 0 || needsEntityName}
            className="gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Import {totalSelected} Asset(s)
          </Button>
        </div>
      </div>
    </div>
  );
}
