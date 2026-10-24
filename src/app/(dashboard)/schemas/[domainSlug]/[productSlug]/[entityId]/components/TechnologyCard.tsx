"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Loader2,
  Zap,
  ChevronDown,
  ChevronRight,
  Send,
  Rocket,
  Shield,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  publishSchemaAction,
  deploySchemaAction,
  getSchemaTargetFieldMappingsAction,
  saveSchemaFieldTypeOverrideAction,
} from "../actions";
import type { SchemaVersion } from "@/types/schema-version";
import { StatusBadge } from "./SchemaVersionList";
import { useGenerateWithInputs } from "./useGenerateWithInputs";
import { SchemaVersionList } from "./SchemaVersionList";
import { SchemaCodePreview } from "./SchemaCodePreview";
import type { SchemaTargetFieldMappingRow } from "@/lib/schema-targets/field-type-overrides";
import type {
  TargetTypeCatalogEntry,
  TargetTypeOption,
} from "@/lib/type-mapping/target-type-catalog";
import {
  getMappingIntelligence,
  summarizeMappingHealth,
  type MappingIntelligence,
} from "@/lib/type-mapping/mapping-intelligence";

function StatusDot({ status }: { status: SchemaVersion["status"] }) {
  const colors: Record<string, string> = {
    draft: "bg-amber-500",
    published: "bg-blue-500",
    deployed: "bg-green-500",
  };

  const labels: Record<string, string> = {
    draft: "Draft",
    published: "Deployed",
    deployed: "Deployed",
  };

  return (
    <div className="flex items-center gap-space-2 text-caption text-muted-foreground">
      <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-gray-400"}`} />
      {labels[status] ?? status}
    </div>
  );
}

function MappingStatusBadge({ row }: { row: SchemaTargetFieldMappingRow }) {
  if (row.isStale) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
        <AlertTriangle className="h-3 w-3" />
        Stale
      </span>
    );
  }

  if (row.overrideSource === "field") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-400">
        <Shield className="h-3 w-3" />
        User override
      </span>
    );
  }

  if (row.overrideSource) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <Shield className="h-3 w-3" />
        Policy override
      </span>
    );
  }

  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      Default
    </span>
  );
}

function groupOptions(options: TargetTypeOption[]): Array<[string, TargetTypeOption[]]> {
  const grouped = new Map<string, TargetTypeOption[]>();
  for (const option of options) {
    const current = grouped.get(option.group) ?? [];
    current.push(option);
    grouped.set(option.group, current);
  }
  return Array.from(grouped.entries());
}

function TypeMappingInspector({
  targetKey,
  targetLabel,
  catalog,
  rows,
  pendingFieldId,
  onChangeType,
  isLoading,
  latestVersion,
}: {
  targetKey: string;
  targetLabel: string;
  catalog: TargetTypeCatalogEntry | null;
  rows: SchemaTargetFieldMappingRow[];
  pendingFieldId: string | null;
  onChangeType: (fieldId: string, mappedType: string) => void;
  isLoading: boolean;
  latestVersion: SchemaVersion | null;
}) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const optionGroups = useMemo(
    () => groupOptions(catalog?.options ?? []),
    [catalog]
  );
  const enrichedRows = useMemo(
    () =>
      rows.map((row) => ({
        row,
        info: getMappingIntelligence({
          sourceType: row.sourceType,
          targetFormat: targetKey,
          mappedType: row.effectiveMappedType,
          defaultMappedType: row.defaultMappedType,
          precision: row.precision,
          scale: row.scale,
          isLossy: row.isLossy,
          lossDescription: row.lossDescription,
          overrideSource: row.overrideSource,
          isOverride: row.isOverride,
          isStale: row.isStale,
        }),
      })),
    [rows, targetKey]
  );
  const summary = useMemo(
    () => summarizeMappingHealth(enrichedRows.map((entry) => entry.info)),
    [enrichedRows]
  );
  const selectedMapping = enrichedRows.find(
    (entry) => entry.row.fieldId === selectedFieldId
  ) ?? enrichedRows[0];

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border/50 bg-muted/10 px-space-4 py-space-6">
        <div className="flex items-center gap-space-2 text-body-small text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading target type mappings...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-space-3 rounded-lg border border-border/50 bg-muted/10 p-space-4">
      <div className="flex flex-wrap items-start justify-between gap-space-3">
        <div className="space-y-1">
          <h4 className="text-body-small font-semibold text-foreground">
            Target Type Overrides
          </h4>
          <p className="text-caption text-muted-foreground">
            Choose the physical {targetLabel} type for each field. Regeneration
            preserves user-selected overrides.
          </p>
        </div>
        {catalog && (
          <a
            href={catalog.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-primary hover:underline"
          >
            Source types: {catalog.docsSource}
          </a>
        )}
      </div>

      <div className="rounded-md border border-border/50 bg-background/60 px-space-3 py-space-2">
        <div className="flex flex-wrap items-center gap-space-3 text-caption">
          <span className="font-semibold text-foreground">Mapping health</span>
          <span className="text-success">{summary.safe} safe</span>
          <span className={summary.risky > 0 ? "text-warning" : "text-muted-foreground"}>
            {summary.risky} risky
          </span>
          <span className={summary.unmapped > 0 ? "text-destructive" : "text-muted-foreground"}>
            {summary.unmapped} unmapped
          </span>
          <span className="text-muted-foreground">{summary.overrides} overrides</span>
          {summary.stale > 0 && (
            <span className="text-amber-400">{summary.stale} stale</span>
          )}
        </div>
      </div>

      {latestVersion?.overrideDriftSummary && latestVersion.overrideDriftSummary.activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-space-3 rounded-md border border-amber-500/20 bg-amber-500/5 px-space-3 py-space-2 text-caption text-muted-foreground">
          <span>
            {latestVersion.overrideDriftSummary.activeCount} persisted override
            {latestVersion.overrideDriftSummary.activeCount !== 1 ? "s" : ""} on
            this version.
          </span>
          {latestVersion.overrideDriftSummary.staleCount > 0 && (
            <span className="text-amber-400">
              {latestVersion.overrideDriftSummary.staleCount} need review.
            </span>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border/50">
        <div className="grid grid-cols-[minmax(140px,1.2fr)_minmax(120px,0.8fr)_minmax(140px,1fr)_minmax(220px,1.4fr)_minmax(160px,0.9fr)] gap-space-3 bg-muted/40 px-space-3 py-space-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Field</span>
          <span>Logical</span>
          <span>Default</span>
          <span>{targetLabel} Type</span>
          <span>Status</span>
        </div>
        <div className="divide-y divide-border/50">
          {enrichedRows.map(({ row, info }) => (
            <div
              key={row.fieldId}
              className="grid grid-cols-[minmax(140px,1.2fr)_minmax(120px,0.8fr)_minmax(140px,1fr)_minmax(220px,1.4fr)_minmax(160px,0.9fr)] gap-space-3 px-space-3 py-space-3 text-body-small"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => setSelectedFieldId(row.fieldId)}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  aria-label={`Review ${row.fieldName} mapping`}
                >
                  {row.fieldName}
                </button>
                {row.comment && (
                  <div className="mt-1 text-caption text-muted-foreground">
                    {row.comment}
                  </div>
                )}
              </div>
              <div className="font-mono text-foreground">{row.sourceType}</div>
              <div className="font-mono text-muted-foreground">
                {row.defaultMappedType ?? "Unmapped"}
              </div>
              <div className="min-w-0">
                <div className="relative">
                  <select
                    value={row.overrideSource === "field" ? row.effectiveMappedType : row.defaultMappedType ?? row.effectiveMappedType}
                    onChange={(event) =>
                      onChangeType(row.fieldId, event.target.value)
                    }
                    className="w-full rounded-md border border-border/50 bg-background px-space-3 py-space-2 pr-10 text-body-small text-foreground"
                    data-testid={`type-override-select-${row.fieldId}`}
                    disabled={pendingFieldId === row.fieldId}
                  >
                    <option value={row.defaultMappedType ?? ""}>
                      Use default{row.defaultMappedType ? ` (${row.defaultMappedType})` : ""}
                    </option>
                    {optionGroups.map(([group, options]) => (
                      <optgroup key={group} label={group}>
                        {options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {pendingFieldId === row.fieldId && (
                    <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                  )}
                </div>
                <div className="mt-1 text-caption text-muted-foreground">
                  Effective: <span className="font-mono">{row.effectiveMappedType}</span>
                </div>
              </div>
              <div className="flex flex-col items-start gap-1 pt-1">
                <MappingStatusBadge row={row} />
                {info.risk.severity !== "safe" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                    <AlertTriangle className="h-3 w-3" />
                    {info.risk.label}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {selectedMapping && (
        <MappingDetailPanel
          fieldName={selectedMapping.row.fieldName}
          info={selectedMapping.info}
        />
      )}
    </div>
  );
}

function MappingDetailPanel({
  fieldName,
  info,
}: {
  fieldName: string;
  info: MappingIntelligence;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-background p-space-4">
      <div className="flex flex-wrap items-start justify-between gap-space-3">
        <div>
          <h5 className="text-body-small font-semibold text-foreground">
            {fieldName} mapping detail
          </h5>
          <p className="mt-1 text-caption text-muted-foreground">
            <span className="font-mono">{info.source.type}</span>
            {" → "}
            <span className="font-mono">{info.mapping.mappedType}</span>
          </p>
        </div>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
          info.risk.severity === "safe"
            ? "bg-success/10 text-success"
            : "bg-warning/10 text-warning"
        }`}>
          {info.risk.label}
        </span>
      </div>

      <div className="mt-space-3 grid gap-space-3 md:grid-cols-2">
        <div className="rounded-md bg-muted/30 p-space-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Example values
          </div>
          <div className="mt-2 space-y-1 text-caption">
            <p>
              Logical:{" "}
              <span className="font-mono text-foreground">
                {info.risk.exampleBefore ?? info.source.example ?? "No example available"}
              </span>
            </p>
            <p>
              Target:{" "}
              <span className="font-mono text-foreground">
                {info.risk.exampleAfter ?? info.mapping.mappedType}
              </span>
            </p>
          </div>
        </div>

        <div className="rounded-md bg-muted/30 p-space-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Possible problems
          </div>
          {info.risk.possibleProblems.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-space-4 text-caption text-muted-foreground">
              {info.risk.possibleProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-caption text-muted-foreground">
              No known data quality issue for this mapping.
            </p>
          )}
        </div>
      </div>

      {info.risk.mitigations.length > 0 && (
        <div className="mt-space-3 rounded-md border border-border/50 px-space-3 py-space-2 text-caption text-muted-foreground">
          <span className="font-medium text-foreground">Safer options: </span>
          {info.risk.mitigations.join(" ")}
        </div>
      )}
    </div>
  );
}

export interface TargetInfo {
  key: string;
  displayName: string;
  icon: React.ReactNode;
  supportsFieldOverrides: boolean;
}

interface TechnologyCardProps {
  targetInfo: TargetInfo;
  versions: SchemaVersion[];
  entityId: string;
  entityVersion: number;
  fieldsCount: number;
  onVersionsChange: () => Promise<void> | void;
  embedded?: boolean;
}

export function TechnologyCard({
  targetInfo,
  versions,
  entityId,
  entityVersion,
  fieldsCount,
  onVersionsChange,
  embedded = false,
}: TechnologyCardProps) {
  const [expanded, setExpanded] = useState(versions.length > 0);
  const [isGenerating, setIsGenerating] = useState(false);
  const { generate, dialog } = useGenerateWithInputs(entityId);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [mappingRows, setMappingRows] = useState<SchemaTargetFieldMappingRow[]>([]);
  const [mappingCatalog, setMappingCatalog] = useState<TargetTypeCatalogEntry | null>(null);
  const [mappingSupported, setMappingSupported] = useState(targetInfo.supportsFieldOverrides);
  const [mappingReason, setMappingReason] = useState<string | null>(null);
  const [isLoadingMappings, setIsLoadingMappings] = useState(false);
  const [pendingFieldId, setPendingFieldId] = useState<string | null>(null);

  const latestVersion = versions.length > 0 ? versions[0] : null;
  const displayVersion =
    viewingVersion != null
      ? versions.find((v) => v.version === viewingVersion)
      : latestVersion;

  const hasChangedSinceLastGen =
    !latestVersion || latestVersion.entityVersion !== entityVersion;
  const generateButtonLabel = !latestVersion
    ? "Generate"
    : hasChangedSinceLastGen
      ? "Update Schema"
      : "Regenerate";
  const generatingButtonLabel = !latestVersion
    ? "Generating..."
    : hasChangedSinceLastGen
      ? "Updating..."
      : "Regenerating...";
  const isOpen = embedded || expanded;

  const loadMappings = useCallback(async () => {
    setIsLoadingMappings(true);
    try {
      const result = await getSchemaTargetFieldMappingsAction(entityId, targetInfo.key);
      if (result.error) {
        setMappingRows([]);
        setMappingReason(result.error);
        setMappingSupported(false);
        return;
      }
      setMappingRows(result.mappings ?? []);
      setMappingCatalog(result.typeCatalog ?? null);
      setMappingSupported(result.supported ?? false);
      setMappingReason(result.reason ?? null);
    } finally {
      setIsLoadingMappings(false);
    }
  }, [entityId, targetInfo.key]);

  useEffect(() => {
    if (!isOpen || !latestVersion) {
      return;
    }
    void loadMappings();
  }, [isOpen, latestVersion, loadMappings]);

  const handleGenerate = useCallback(async () => {
    if (fieldsCount === 0) {
      toast.error("Add fields before generating schemas");
      return;
    }
    setIsGenerating(true);
    try {
      const result = await generate(targetInfo.key);
      if (!result) return; // the user declined to answer what the target needs
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${targetInfo.displayName} v${result.schemaVersion?.version} generated`
      );
      setViewingVersion(null);
      await Promise.resolve(onVersionsChange());
      await loadMappings();
    } catch {
      toast.error("Generation failed unexpectedly");
    } finally {
      setIsGenerating(false);
    }
  }, [generate, targetInfo, fieldsCount, onVersionsChange, loadMappings]);

  const handlePublish = useCallback(
    async (version: number) => {
      setActionPending(`publish-${version}`);
      try {
        const result = await publishSchemaAction(entityId, targetInfo.key, version);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        toast.success(`${targetInfo.displayName} v${version} published`);
        await Promise.resolve(onVersionsChange());
      } catch {
        toast.error("Publish failed");
      } finally {
        setActionPending(null);
      }
    },
    [entityId, targetInfo, onVersionsChange]
  );

  const handleDeploy = useCallback(
    async (version: number) => {
      setActionPending(`deploy-${version}`);
      try {
        const result = await deploySchemaAction(entityId, targetInfo.key, version);
        if (result.error) {
          toast.error(result.error);
          return;
        }
        toast.success(`${targetInfo.displayName} v${version} deployed`);
        await Promise.resolve(onVersionsChange());
      } catch {
        toast.error("Deploy failed");
      } finally {
        setActionPending(null);
      }
    },
    [entityId, targetInfo, onVersionsChange]
  );

  const handleOverrideChange = useCallback(
    async (fieldId: string, mappedType: string) => {
      setPendingFieldId(fieldId);
      try {
        const result = await saveSchemaFieldTypeOverrideAction({
          entityId,
          target: targetInfo.key,
          fieldId,
          mappedType,
        });
        if (result.error) {
          toast.error(result.error);
          return;
        }

        toast.success(
          mappedType
            ? `${targetInfo.displayName} type override saved`
            : `${targetInfo.displayName} type override cleared`
        );
        setViewingVersion(null);
        await Promise.resolve(onVersionsChange());
        await loadMappings();
      } catch {
        toast.error("Failed to save type override");
      } finally {
        setPendingFieldId(null);
      }
    },
    [entityId, loadMappings, onVersionsChange, targetInfo]
  );

  const content = (
    <div className="px-space-4 py-space-4 space-y-space-4">
      {versions.length === 0 ? (
        <p className="text-body-small text-muted-foreground text-center py-space-6">
          No schemas generated yet. Click Generate to create the first schema.
        </p>
      ) : (
        <>
          {!hasChangedSinceLastGen && (
            <p className="text-caption text-muted-foreground italic">
              No changes since last schema generation (entity v{entityVersion}).
            </p>
          )}

          <SchemaVersionList
            versions={versions}
            activeVersion={displayVersion?.version ?? null}
            onSelectVersion={setViewingVersion}
          />

          {displayVersion && (
            <div className="space-y-space-3">
              {targetInfo.supportsFieldOverrides && mappingSupported && (
                <TypeMappingInspector
                  targetKey={targetInfo.key}
                  targetLabel={targetInfo.displayName}
                  catalog={mappingCatalog}
                  rows={mappingRows}
                  pendingFieldId={pendingFieldId}
                  onChangeType={(fieldId, mappedType) => {
                    void handleOverrideChange(fieldId, mappedType);
                  }}
                  isLoading={isLoadingMappings}
                  latestVersion={displayVersion}
                />
              )}

              <SchemaCodePreview
                code={displayVersion.output}
                language={targetInfo.key === "avro" ? "json" : targetInfo.key === "openapi" ? "yaml" : "sql"}
                onCopy={() => toast.success("Schema copied to clipboard")}
              />

              <div className="flex items-center justify-between">
                <StatusDot status={displayVersion.status} />
                <div className="flex items-center gap-space-2">
                  {displayVersion.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={actionPending === `publish-${displayVersion.version}`}
                      onClick={() => void handlePublish(displayVersion.version)}
                    >
                      {actionPending === `publish-${displayVersion.version}` ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                      Mark Deployed
                    </Button>
                  )}
                  {displayVersion.status === "published" && (
                    <Button
                      size="sm"
                      variant="default"
                      className="gap-1.5"
                      disabled={actionPending === `deploy-${displayVersion.version}`}
                      onClick={() => void handleDeploy(displayVersion.version)}
                    >
                      {actionPending === `deploy-${displayVersion.version}` ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Rocket className="w-3.5 h-3.5" />
                      )}
                      Deploy
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          {targetInfo.supportsFieldOverrides && !mappingSupported && mappingReason && (
            <p className="rounded-md border border-border/50 bg-muted/10 px-space-3 py-space-2 text-caption text-muted-foreground">
              {mappingReason}
            </p>
          )}
        </>
      )}
      {dialog}
    </div>
  );

  if (embedded) {
    return (
      <div
        className="rounded-lg border border-border/50 bg-background"
        data-testid={`schema-card-${targetInfo.key}`}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-border/50 overflow-hidden"
      data-testid={`schema-card-${targetInfo.key}`}
    >
      <div
        className="flex items-center justify-between px-space-4 py-space-3 bg-muted/20 cursor-pointer select-none"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex items-center gap-space-2">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="text-muted-foreground">{targetInfo.icon}</span>
          <span className="text-body-small font-medium text-foreground">
            {targetInfo.displayName}
          </span>
          {latestVersion && <StatusBadge status={latestVersion.status} />}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isGenerating || fieldsCount === 0}
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
          data-testid={`generate-${targetInfo.key}`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {generatingButtonLabel}
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5" />
              {generateButtonLabel}
            </>
          )}
        </Button>
      </div>

      {expanded && content}
    </div>
  );
}
