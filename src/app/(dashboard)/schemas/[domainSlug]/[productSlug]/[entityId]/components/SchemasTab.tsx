"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2,
  Database,
  FileJson,
  Globe,
  Boxes,
  Code2,
  Server,
  ChevronDown,
  Send,
  Check,
  AlertTriangle,
  Layers,
} from "lucide-react";
import { GenerationIcon } from "@/components/icons/feature-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { getSchemaVersionsAction, publishSchemaAction, saveSchemaFieldTypeOverrideAction } from "../actions";
import type { SchemaVersionsMap, FieldTypeMapping } from "@/types/schema-version";
import { SchemaVersionOutput } from "./SchemaVersionOutput";
import { useGenerateWithInputs } from "./useGenerateWithInputs";
import { publishRefusalToast } from "./publish-refusal";
import { generationWarningToast, stagedWarningToast } from "./generate-warnings";
import { StagedEmitDialog } from "@/features/emission/StagedEmitDialog/StagedEmitDialog";
import { getTargetTypeOptions, type TargetTypeOption } from "@/lib/type-mapping/target-type-catalog";
import {
  getSchemaTargetAvailabilities,
  getSchemaTargetDefinition,
} from "@/lib/schema-targets/catalog";
import {
  buildMappingMatrixRows,
  summarizeMappingHealth,
  getMappingIntelligence,
} from "@/lib/type-mapping/mapping-intelligence";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldData {
  id: string;
  slug?: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

export interface SchemasTabProps {
  onDeploy?: (format: string, version: number) => void;
  entityId: string;
  entityName: string;
  fields: FieldData[];
  entity: {
    id: string;
    name: string;
    slug: string;
    domainSlug: string | null;
    version: number;
    metadata: Record<string, unknown> | null;
  };
}

interface TargetMeta {
  key: string;
  displayName: string;
  icon: React.ReactNode;
  language: string;
  /** Its generation applies a stored per-field type override: only then is the Manual Override table offered (catalog.ts). */
  supportsFieldOverrides: boolean;
}

// ---------------------------------------------------------------------------
// Target metadata
// ---------------------------------------------------------------------------

function getTargetMeta(key: string): TargetMeta {
  const info = getSchemaTargetDefinition(key);
  const iconByKey: Record<string, typeof Database> = {
    bigquery: Database, avro: FileJson, spanner: Database,
    postgresql: Database, openapi3: Globe,
    "json-schema": FileJson, protobuf: Boxes, "java-pojo": Code2,
    "http-client-js": Code2, "http-server-js": Server,
  };
  const langByKey: Record<string, string> = {
    bigquery: "sql", avro: "json", spanner: "sql", postgresql: "sql",
    openapi3: "yaml", "json-schema": "json", "java-pojo": "java",
  };
  const IconComponent = iconByKey[key] ?? FileJson;
  return {
    key,
    displayName: info?.displayName ?? key,
    icon: <IconComponent className="w-4 h-4" />,
    language: langByKey[key] ?? "text",
    supportsFieldOverrides: info?.supportsFieldOverrides === true,
  };
}

// ---------------------------------------------------------------------------
// Rich type picker popover
// ---------------------------------------------------------------------------

function TargetTypePicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: TargetTypeOption[];
  onChange: (newType: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Group options
  const groups = new Map<string, TargetTypeOption[]>();
  for (const opt of options) {
    const g = groups.get(opt.group) ?? [];
    g.push(opt);
    groups.set(opt.group, g);
  }


  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="override-type-trigger"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 h-7 w-full rounded-lg border border-border bg-popover px-2 text-[11px] font-mono text-primary hover:border-primary/40 transition-colors"
      >
        <span className="truncate flex-1 text-left">{value}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-[320px] max-h-[320px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lg py-1" role="listbox" aria-label="Target data types">
          {[...groups.entries()].map(([group, opts]) => (
            <div key={group}>
              <div className="px-3 py-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold sticky top-0 bg-popover">
                {group}
              </div>
              {opts.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  className={`flex items-start gap-2 w-full text-left px-3 py-1.5 hover:bg-accent transition-colors ${
                    opt.value === value ? "bg-accent/50" : ""
                  }`}
                >
                  <span className="font-mono text-[11px] text-primary shrink-0 w-[120px]">{opt.label}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">{opt.description}</span>
                  {opt.value === value && <Check className="w-3 h-3 text-success shrink-0 mt-0.5 ml-auto" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type override table with rich picker
// ---------------------------------------------------------------------------

function TypeOverrideTable({
  fields,
  targetKey,
  targetDisplayName,
  fieldTypeMappings,
  localOverrides,
  onOverrideChange,
}: {
  fields: FieldData[];
  targetKey: string;
  targetDisplayName: string;
  fieldTypeMappings?: FieldTypeMapping[];
  localOverrides?: Map<string, string>;
  onOverrideChange: (fieldName: string, newType: string) => void;
}) {
  const mappingByField = new Map<string, string>();
  if (fieldTypeMappings) {
    for (const m of fieldTypeMappings) {
      mappingByField.set(m.fieldName, m.targetType);
    }
  }

  const validTypes = getTargetTypeOptions(targetKey);

  return (
    <div className="space-y-2">
      <p className="text-caption text-muted-foreground">
        Override the default {targetDisplayName} data type per field. Changes are saved immediately and regenerate this schema.
      </p>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <table className="w-full text-caption">
          <thead>
            <tr className="bg-muted/30 border-b border-border/50">
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px] w-[180px]">Field</th>
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px] w-[120px]">Super Schema Type</th>
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px]">{targetDisplayName} Data Type</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, i) => {
              // Priority: local override > stored mapping > default engine > raw type
              const localType = localOverrides?.get(field.name);
              const storedType = mappingByField.get(field.name);
              const defaultType = getMappingIntelligence({ sourceType: field.type, targetFormat: targetKey }).mapping.mappedType;
              const currentType = localType ?? storedType ?? defaultType ?? field.type;
              const isOverridden = (localType && localType !== defaultType) || (storedType && storedType !== defaultType);
              return (
                <tr key={field.id} data-testid="override-row" data-field={field.name} data-overridden={isOverridden ? "true" : "false"} className={`${i % 2 === 0 ? "" : "bg-muted/10"} ${isOverridden ? "bg-primary/5" : ""}`}>
                  <td className="px-3 py-1.5 font-mono text-foreground">
                    {field.name}
                    {isOverridden && <Badge variant="outline" className="text-[8px] h-3 px-1 ml-1">overridden</Badge>}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{field.type}</td>
                  <td className="px-3 py-1.5">
                    <TargetTypePicker
                      value={currentType}
                      options={validTypes}
                      onChange={(newType) => onOverrideChange(field.name, newType)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MappingMatrixView({
  fields,
  targets,
}: {
  fields: FieldData[];
  targets: Array<{ key: string; displayName: string }>;
}) {
  const matrixRows = buildMappingMatrixRows({
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      precision: field.precision,
      scale: field.scale,
    })),
    targets: targets.map((target) => target.key),
  });
  const allMappings = matrixRows.flatMap((row) =>
    targets.map((target) => row.cells[target.key])
  );
  const summary = summarizeMappingHealth(allMappings);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/50 bg-muted/10 p-space-4">
        <div className="flex flex-wrap items-center justify-between gap-space-3">
          <div>
            <h3 className="text-body-small font-semibold text-foreground">
              Mapping Matrix
            </h3>
            <p className="mt-1 text-caption text-muted-foreground">
              Compare logical field types across every schema target before generation.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-space-2 text-caption">
            <Badge variant="outline">{summary.safe} safe</Badge>
            <Badge variant={summary.risky > 0 ? "warning" : "outline"}>
              {summary.risky} risky
            </Badge>
            <Badge variant={summary.unmapped > 0 ? "destructive" : "outline"}>
              {summary.unmapped} unmapped
            </Badge>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/50">
        <table className="w-full min-w-[760px] text-caption">
          <thead>
            <tr className="bg-muted/30 border-b border-border/50">
              <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
                Field
              </th>
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
                Logical
              </th>
              {targets.map((target) => (
                <th
                  key={target.key}
                  className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80"
                >
                  {target.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrixRows.map((row, index) => (
              <tr
                key={row.fieldId}
                className={`${index % 2 === 0 ? "" : "bg-muted/10"}`}
              >
                <td className="sticky left-0 z-10 bg-background px-3 py-2 font-medium text-foreground">
                  {row.fieldName}
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-foreground">{row.sourceType}</div>
                  {row.sourceExample && (
                    <div className="mt-1 max-w-[180px] truncate text-[10px] text-muted-foreground">
                      {row.sourceExample}
                    </div>
                  )}
                </td>
                {targets.map((target) => {
                  const cell = row.cells[target.key];
                  return (
                    <td key={target.key} className="px-3 py-2 align-top">
                      <div className="font-mono text-foreground">
                        {cell.mapping.mappedType}
                      </div>
                      {cell.risk.severity !== "safe" && (
                        <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
                          <AlertTriangle className="h-3 w-3" />
                          {cell.risk.label}
                        </div>
                      )}
                      {cell.risk.severity === "safe" && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          Safe mapping
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchemasTab
// ---------------------------------------------------------------------------

type ContentTab = "schema" | "overrides" | "matrix";

export function SchemasTab({ entityId, entityName, fields, entity, onDeploy }: SchemasTabProps) {
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersionsMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<ContentTab>("schema");
  const [isGenerating, setIsGenerating] = useState(false);
  const { generate, resolveReferences, dialog } = useGenerateWithInputs(entityId);
  const [isPublishing, setIsPublishing] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(false);
  // Local override state (not yet saved until regeneration)
  const [localOverrides, setLocalOverrides] = useState<Map<string, Map<string, string>>>(new Map());
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);

  const loadVersions = useCallback(async () => {
    const result = await getSchemaVersionsAction(entityId);
    if (result.schemaVersions) {
      setSchemaVersions(result.schemaVersions);
    }
    setIsLoading(false);
  }, [entityId]);

  useEffect(() => { loadVersions(); }, [loadVersions]);

  const catalogTargets = getSchemaTargetAvailabilities();
  const generatedTargetKeys = Object.keys(schemaVersions)
    .filter((target) => (schemaVersions[target] ?? []).length > 0);

  const allTargets = catalogTargets
    .filter((entry) => entry.available || generatedTargetKeys.includes(entry.target.key))
    .map((entry) => {
      const versions = (schemaVersions[entry.target.key] ?? []).toSorted((a, b) =>
        Number(b.status === "draft") - Number(a.status === "draft") || b.version - a.version
      );
      return {
        ...getTargetMeta(entry.target.key),
        hasVersions: versions.length > 0,
        versions,
        // Legacy deployment markers do not establish an environment deployment.
        latestPublishedVersion: versions.find((version) => version.status !== "draft"),
      };
    });

  useEffect(() => {
    if (selectedTarget) return;
    const withVersions = allTargets.find((t) => t.hasVersions);
    if (withVersions) { setSelectedTarget(withVersions.key); return; }
    if (allTargets.length > 0) setSelectedTarget(allTargets[0].key);
  }, [allTargets, selectedTarget]);

  async function handleGenerate(targetKey: string) {
    if (fields.length === 0) { toast.error("Add fields first"); return; }
    setIsGenerating(true);
    try {
      const result = await generate(targetKey);
      if (!result) return; // the user declined to answer what the target needs
      if (result.error) { toast.error(result.error); return; }
      // A target generated WITH warnings (status WARNING) says so in one toast instead of the plain success one, and
      // lists them there: nothing else shows them (the SchemaVersion stores none).
      const warningToast = generationWarningToast(result.warnings);
      if (warningToast) toast.warning(warningToast.title, warningToast.options);
      else toast.success(`${getTargetMeta(targetKey).displayName} schema generated (Draft)`);
      setViewingVersion(null);
      await loadVersions();
    } catch { toast.error("Generation failed"); }
    finally { setIsGenerating(false); }
  }

  // The way out of a refused preview (a version that used the saved draft of an entity it references): regenerate from the published
  // versions and publish the result. Offered on the refusal toast, never done silently.
  async function handleRegenerateAndPublish(targetKey: string, version: number) {
    setIsPublishing(true);
    try {
      // An ambiguous reference met while regenerating is asked first (the pick is saved, the publish runs once more), before any error.
      const result = await resolveReferences(() => publishSchemaAction(entityId, targetKey, version, { regenerateFromPublished: true }));
      if (!result) return; // the user declined to choose
      if (result.error) { toast.error(result.error); return; }
      toast.success(`${getTargetMeta(targetKey).displayName} regenerated from the published versions and published`);
      await loadVersions();
    } catch { toast.error("Publish failed"); }
    finally { setIsPublishing(false); }
  }

  async function handlePublish(targetKey: string, version: number) {
    setIsPublishing(true);
    try {
      // A publish blocked by an ambiguous reference answers the pick beside its error: ask it, save it, publish once more.
      const result = await resolveReferences(() => publishSchemaAction(entityId, targetKey, version));
      if (!result) return; // the user declined to choose
      if (result.error) {
        const refusal = publishRefusalToast(result, () => void handleRegenerateAndPublish(targetKey, version));
        if (refusal.options) toast.error(refusal.message, refusal.options);
        else toast.error(refusal.message);
        return;
      }
      toast.success(`${getTargetMeta(targetKey).displayName} v${version} published`);
      await loadVersions();
    } catch { toast.error("Publish failed"); }
    finally { setIsPublishing(false); }
  }

  async function handleStagedEmit(selectedTargets: string[]) {
    if (fields.length === 0) { toast.error("Add fields first"); return; }
    setStagedOpen(false);
    setIsGenerating(true);
    let ok = 0;
    const runs: Array<{ label: string; warnings: string[] | undefined }> = [];
    try {
      for (const targetKey of selectedTargets) {
        const result = await generate(targetKey);
        if (!result) continue; // declined: skip this target, carry on with the others
        if (result.error) { toast.error(`${getTargetMeta(targetKey).displayName}: ${result.error}`); continue; }
        ok += 1;
        runs.push({ label: getTargetMeta(targetKey).displayName, warnings: result.warnings });
      }
      if (ok > 0) {
        // One toast for the whole run: the plain success text unless some target had warnings, then they are listed.
        const warningToast = stagedWarningToast(ok, runs);
        if (warningToast) toast.warning(warningToast.title, warningToast.options);
        else toast.success(`Generated ${ok} schema${ok === 1 ? "" : "s"} (Draft)`);
        setViewingVersion(null);
        await loadVersions();
      }
    } catch { toast.error("Staged emission failed"); }
    finally { setIsGenerating(false); }
  }

  async function handleOverrideChange(targetKey: string, fieldName: string, newType: string) {
    // Update local state immediately for UI feedback
    setLocalOverrides((prev) => {
      const next = new Map(prev);
      const targetMap = new Map(next.get(targetKey) ?? []);
      targetMap.set(fieldName, newType);
      next.set(targetKey, targetMap);
      return next;
    });

    const field = fields.find((f) => f.name === fieldName);
    if (!field) return;

    // Save action persists override AND regenerates schema internally
    setIsGenerating(true);
    try {
      const saveResult = await saveSchemaFieldTypeOverrideAction({
        entityId,
        target: targetKey,
        fieldId: field.id,
        mappedType: newType,
      });

      if (saveResult.error) {
        toast.error(saveResult.error);
        return;
      }

      // The save regenerates the schema: its warnings are the generation's, shown the same way.
      const warningToast = generationWarningToast(saveResult.warnings);
      if (warningToast) toast.warning(warningToast.title, warningToast.options);
      else toast.success("Override applied — schema regenerated");
      setViewingVersion(null);
      await loadVersions();
    } catch {
      toast.error("Failed to apply override");
    } finally {
      setIsGenerating(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-space-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <span className="ml-space-2 text-body-small text-muted-foreground">Loading schemas...</span>
      </div>
    );
  }

  const selected = allTargets.find((t) => t.key === selectedTarget);
  const selectedVersions = selected?.versions ?? [];
  const latestVersion = selectedVersions[0];
  const displayVersion = selectedVersions.find((version) => version.version === viewingVersion) ?? latestVersion;

  return (
    <div data-testid="schemas-tab">
      <div className="flex min-w-0 flex-col gap-space-4 sm:flex-row">
        {/* Technology selection and latest published artifact */}
        <div className="flex shrink-0 gap-1 overflow-x-auto sm:w-[160px] sm:flex-col">
          {allTargets.map((target) => {
            const isSelected = selectedTarget === target.key;
            const version = target.latestPublishedVersion ?? target.versions[0];
            const status = version?.status === "draft" ? "Draft" : "Published";
            const versionLabel = `${target.displayName} v${version?.version} — ${status}`;

            return (
              <button
                key={target.key}
                type="button"
                data-testid={`schema-target-${target.key}`}
                aria-pressed={isSelected}
                onClick={() => {
                  if (!isSelected) setViewingVersion(null);
                  setSelectedTarget(target.key);
                  setContentTab((current) => current === "matrix" ? "matrix" : "schema");
                }}
                className={cn(
                  "flex min-w-0 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-body-small transition-colors",
                  isSelected
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <span className="shrink-0">{target.icon}</span>
                <span className="truncate flex-1 text-left">{target.displayName}</span>
                {version && (
                  <Badge
                    variant={version.status === "draft" ? "secondary" : "info"}
                    className="h-5 shrink-0 px-1 text-[9px]"
                    aria-label={versionLabel}
                    title={versionLabel}
                    data-testid="schema-target-version"
                    data-target={target.key}
                    data-version={version.version}
                    data-status={version.status === "draft" ? "draft" : "published"}
                  >
                    v{version.version}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <>
              {/* Horizontal tabs + actions */}
              <div className="mb-space-3 flex flex-wrap items-center gap-2 border-b border-border/50">
                <div className="flex min-w-0 max-w-full gap-1 overflow-x-auto">
                  <button
                    type="button"
                    data-testid="schema-content-tab-schema"
                    aria-pressed={contentTab === "schema"}
                    onClick={() => setContentTab("schema")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "schema" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Generated Schema
                  </button>
                  {selected.supportsFieldOverrides && (
                    <button
                      type="button"
                      data-testid="schema-content-tab-overrides"
                      aria-pressed={contentTab === "overrides"}
                      onClick={() => setContentTab("overrides")}
                      className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                        contentTab === "overrides" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Manual Override
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="schema-content-tab-matrix"
                    aria-pressed={contentTab === "matrix"}
                    onClick={() => setContentTab("matrix")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "matrix" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Mapping Matrix
                  </button>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {/* Generate button */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={isGenerating || fields.length === 0}
                    onClick={() => handleGenerate(selected.key)}
                    data-testid="schema-generate"
                  >
                    {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GenerationIcon className="w-3.5 h-3.5" />}
                    {latestVersion ? "Regenerate" : "Generate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={isGenerating || fields.length === 0 || allTargets.length === 0}
                    onClick={() => setStagedOpen(true)}
                    data-testid="schema-stage-emit"
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Generate selected formats
                  </Button>
                </div>
              </div>

              {/* Artifact publication status is independent of delivery and environment tracking. */}
              {contentTab === "schema" && (
                displayVersion ? (
                  <Tabs
                    key={selected.key}
                    value={String(displayVersion.version)}
                    onValueChange={(value) => setViewingVersion(Number(value))}
                    className="min-w-0"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 overflow-x-auto p-1">
                        <TabsList variant="line" activateOnFocus aria-label={`${selected.displayName} schema versions`}>
                          {selectedVersions.map((version) => {
                            const status = version.status === "draft" ? "Draft" : "Published";
                            const label = `v${version.version} — ${status}`;
                            return (
                              <TabsTrigger
                                key={version.version}
                                value={String(version.version)}
                                aria-label={label}
                                title={label}
                                data-testid="schema-version-button"
                                data-version={version.version}
                                data-status={status.toLowerCase()}
                                className="shrink-0 px-3"
                              >
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    status === "Draft" ? "bg-warning" : version.version === selected.latestPublishedVersion?.version ? "bg-info" : "bg-muted-foreground/40"
                                  )}
                                />
                                v{version.version}
                                {status === "Draft" && <span className="text-caption">Draft</span>}
                              </TabsTrigger>
                            );
                          })}
                        </TabsList>
                      </div>
                      {displayVersion.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto shrink-0 gap-1.5"
                          disabled={isPublishing}
                          data-testid="schema-publish"
                          onClick={() => handlePublish(selected.key, displayVersion.version)}
                        >
                          {isPublishing ? <Loader2 className="animate-spin" /> : <Send />}
                          Publish schema
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="ml-auto shrink-0 gap-1.5"
                        disabled={displayVersion.status === "draft" || isPublishing}
                        title={displayVersion.status === "draft" ? "Publish this version before deploying" : "Choose a delivery workflow for this exact version"}
                        data-testid="schema-deploy"
                        onClick={() => {
                          if (onDeploy) { onDeploy(selected.key, displayVersion.version); return; }
                          const url = new URL(window.location.href);
                          url.searchParams.set("tab", "deployments");
                          url.searchParams.set("schemaFormat", selected.key);
                          url.searchParams.set("schemaVersion", String(displayVersion.version));
                          window.location.assign(url);
                        }}
                      >
                        <Send data-icon="inline-start" />Deploy…
                      </Button>
                    </div>
                    {selectedVersions.map((version) => (
                      <TabsContent key={version.version} value={String(version.version)} className="min-w-0">
                        <SchemaVersionOutput
                          version={version}
                          entityId={entityId}
                          entityName={entityName}
                          language={selected.language}
                          onCopy={() => toast.success("Copied to clipboard")}
                        />
                      </TabsContent>
                    ))}
                  </Tabs>
                ) : (
                  <div className="text-center py-space-8 text-muted-foreground">
                    <p className="text-body-small">No schema generated yet</p>
                    <p className="text-caption mt-1">Click Generate to create the {selected.displayName} schema</p>
                  </div>
                )
              )}

              {/* Manual overrides */}
              {contentTab === "overrides" && selected.supportsFieldOverrides && (
                <TypeOverrideTable
                  fields={fields}
                  targetKey={selected.key}
                  targetDisplayName={selected.displayName}
                  fieldTypeMappings={latestVersion?.fieldTypeMappings}
                  localOverrides={localOverrides.get(selected.key)}
                  onOverrideChange={(fieldName, newType) => handleOverrideChange(selected.key, fieldName, newType)}
                />
              )}

              {contentTab === "matrix" && (
                <MappingMatrixView
                  fields={fields}
                  targets={allTargets.map((target) => ({
                    key: target.key,
                    displayName: target.displayName,
                  }))}
                />
              )}
            </>
          ) : (
            <div className="text-center py-space-8 text-muted-foreground">
              <p className="text-body-small">Select a technology to view or generate schemas</p>
            </div>
          )}
        </div>
      </div>

      <StagedEmitDialog
        open={stagedOpen}
        onClose={() => setStagedOpen(false)}
        entityName={entityName}
        versionId={entity.version}
        targets={allTargets.map((target) => ({
          target: target.key,
          compatible: true,
          migrationComplexity: "trivial" as const,
          details: target.displayName,
        }))}
        onEmitSelected={handleStagedEmit}
      />
      {dialog}
    </div>
  );
}
