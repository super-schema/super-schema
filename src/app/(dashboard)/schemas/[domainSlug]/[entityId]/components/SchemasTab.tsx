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
  Zap,
  ChevronDown,
  Send,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getSchemaVersionsAction, generateSchemaAction, publishSchemaAction, saveSchemaFieldTypeOverrideAction } from "../actions";
import type { SchemaVersionsMap, SchemaVersion, FieldTypeMapping } from "../actions";
import { SchemaCodePreview } from "./SchemaCodePreview";
import { getDefaultMapping } from "@/lib/type-mapping/default-mappings";
import { getTargetTypeOptions, type TargetTypeOption } from "@/lib/type-mapping/target-type-catalog";
import {
  getSchemaTargetAvailabilities,
  getSchemaTargetDefinition,
} from "@/lib/schema-targets/catalog";

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
  entityId: string;
  entityName: string;
  fields: FieldData[];
  entity: {
    id: string;
    name: string;
    slug: string;
    domainSlug: string;
    version: number;
    metadata: Record<string, unknown> | null;
  };
}

interface TargetMeta {
  key: string;
  displayName: string;
  icon: React.ReactNode;
  language: string;
}

// ---------------------------------------------------------------------------
// Target metadata
// ---------------------------------------------------------------------------

function getTargetMeta(key: string): TargetMeta {
  const info = getSchemaTargetDefinition(key);
  const iconByKey: Record<string, typeof Database> = {
    bigquery: Database, avro: FileJson, spanner: Database,
    postgresql: Database, openapi: Globe, openapi3: Globe,
    "json-schema": FileJson, protobuf: Boxes,
    "http-client-js": Code2, "http-server-js": Server,
  };
  const langByKey: Record<string, string> = {
    bigquery: "sql", avro: "json", spanner: "sql", postgresql: "sql",
    openapi: "yaml", openapi3: "yaml", "json-schema": "json",
  };
  const IconComponent = iconByKey[key] ?? FileJson;
  return {
    key,
    displayName: info?.displayName ?? key,
    icon: <IconComponent className="w-4 h-4" />,
    language: langByKey[key] ?? "text",
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
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Group options
  const groups = new Map<string, TargetTypeOption[]>();
  for (const opt of options) {
    const g = groups.get(opt.group) ?? [];
    g.push(opt);
    groups.set(opt.group, g);
  }

  const current = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 h-7 w-full rounded-lg border border-border bg-popover px-2 text-[11px] font-mono text-primary hover:border-primary/40 transition-colors"
      >
        <span className="truncate flex-1 text-left">{value}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-[320px] max-h-[320px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lg py-1">
          {[...groups.entries()].map(([group, opts]) => (
            <div key={group}>
              <div className="px-3 py-1 text-[9px] text-muted-foreground/60 uppercase tracking-wider font-semibold sticky top-0 bg-popover">
                {group}
              </div>
              {opts.map((opt) => (
                <button
                  key={opt.value}
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
        Override the default {targetDisplayName} data type per field. Changes will be applied on next schema generation.
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
              const defaultType = getDefaultMapping(field.type, targetKey)?.mappedType;
              const currentType = localType ?? storedType ?? defaultType ?? field.type;
              const isOverridden = (localType && localType !== defaultType) || (storedType && storedType !== defaultType);
              return (
                <tr key={field.id} className={`${i % 2 === 0 ? "" : "bg-muted/10"} ${isOverridden ? "bg-primary/5" : ""}`}>
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

// ---------------------------------------------------------------------------
// SchemasTab
// ---------------------------------------------------------------------------

type ContentTab = "schema" | "overrides";

export function SchemasTab({ entityId, entityName, fields, entity }: SchemasTabProps) {
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersionsMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<ContentTab>("schema");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  // Local override state (not yet saved until regeneration)
  const [localOverrides, setLocalOverrides] = useState<Map<string, Map<string, string>>>(new Map());

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
    .map((entry) => ({
      ...getTargetMeta(entry.target.key),
      hasVersions: generatedTargetKeys.includes(entry.target.key),
      versionCount: (schemaVersions[entry.target.key] ?? []).length,
      latestVersion: (schemaVersions[entry.target.key] ?? [])[0] as SchemaVersion | undefined,
    }));

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
      const result = await generateSchemaAction(entityId, targetKey);
      if (result.error) { toast.error(result.error); return; }
      toast.success(`${getTargetMeta(targetKey).displayName} schema generated (Draft)`);
      await loadVersions();
    } catch { toast.error("Generation failed"); }
    finally { setIsGenerating(false); }
  }

  async function handlePublish(targetKey: string, version: number) {
    setIsPublishing(true);
    try {
      const result = await publishSchemaAction(entityId, targetKey, version);
      if (result.error) { toast.error(result.error); return; }
      toast.success(`${getTargetMeta(targetKey).displayName} v${version} marked as deployed`);
      await loadVersions();
    } catch { toast.error("Deploy failed"); }
    finally { setIsPublishing(false); }
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

    // Find the field ID
    const field = fields.find((f) => f.name === fieldName);
    if (!field) return;

    // Persist the override
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

    // Auto-regenerate the schema with the override applied
    toast.info("Applying override...");
    await handleGenerate(targetKey);
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
  const selectedVersions = selectedTarget ? (schemaVersions[selectedTarget] ?? []) : [];
  const latestVersion = selectedVersions[0];

  return (
    <div data-testid="schemas-tab">
      <div className="flex items-center justify-between mb-space-4">
        <h2 className="text-heading-2 text-foreground">Schemas</h2>
        <span className="text-caption text-muted-foreground">{entityName} &middot; v{entity.version}</span>
      </div>

      <div className="flex gap-space-4">
        {/* Vertical technology tabs */}
        <div className="w-[160px] shrink-0 space-y-1">
          {allTargets.map((target) => (
            <button
              key={target.key}
              onClick={() => { setSelectedTarget(target.key); setContentTab("schema"); }}
              className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-body-small transition-colors ${
                selectedTarget === target.key
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <span className="shrink-0">{target.icon}</span>
              <span className="truncate flex-1 text-left">{target.displayName}</span>
              {target.hasVersions && (
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 shrink-0">
                  v{target.latestVersion?.version}
                </Badge>
              )}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <>
              {/* Horizontal tabs + actions */}
              <div className="flex items-center justify-between border-b border-border/50 mb-space-3">
                <div className="flex gap-1">
                  <button
                    onClick={() => setContentTab("schema")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "schema" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Generated Schema
                  </button>
                  <button
                    onClick={() => setContentTab("overrides")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "overrides" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Manual Override
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  {/* Status badge */}
                  {latestVersion && (
                    <Badge
                      variant={latestVersion.status === "draft" ? "warning" : "success"}
                      className="text-[10px] h-5"
                    >
                      {latestVersion.status === "draft" ? "Draft" : "Deployed"}
                    </Badge>
                  )}
                  {/* Mark as Deployed button */}
                  {latestVersion?.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={isPublishing}
                      onClick={() => handlePublish(selected.key, latestVersion.version)}
                    >
                      {isPublishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Mark Deployed
                    </Button>
                  )}
                  {/* Generate button */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    disabled={isGenerating || fields.length === 0}
                    onClick={() => handleGenerate(selected.key)}
                  >
                    {isGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    {latestVersion ? "Regenerate" : "Generate"}
                  </Button>
                </div>
              </div>

              {/* Schema content */}
              {contentTab === "schema" && (
                latestVersion ? (
                  <SchemaCodePreview
                    code={latestVersion.output}
                    language={selected.language}
                    onCopy={() => toast.success("Copied to clipboard")}
                  />
                ) : (
                  <div className="text-center py-space-8 text-muted-foreground">
                    <p className="text-body-small">No schema generated yet</p>
                    <p className="text-caption mt-1">Click Generate to create the {selected.displayName} schema</p>
                  </div>
                )
              )}

              {/* Manual overrides */}
              {contentTab === "overrides" && (
                <TypeOverrideTable
                  fields={fields}
                  targetKey={selected.key}
                  targetDisplayName={selected.displayName}
                  fieldTypeMappings={latestVersion?.fieldTypeMappings}
                  localOverrides={localOverrides.get(selected.key)}
                  onOverrideChange={(fieldName, newType) => handleOverrideChange(selected.key, fieldName, newType)}
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
    </div>
  );
}
