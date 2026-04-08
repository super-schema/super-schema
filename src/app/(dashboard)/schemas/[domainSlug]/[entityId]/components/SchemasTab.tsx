"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Database,
  FileJson,
  Globe,
  Boxes,
  Code2,
  Server,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getSchemaVersionsAction, generateSchemaAction } from "../actions";
import type { SchemaVersionsMap, SchemaVersion } from "../actions";
import { SchemaCodePreview } from "./SchemaCodePreview";
// SchemaTargetChooser no longer needed — vertical tabs replace it
import {
  getSchemaTargetAvailabilities,
  getSchemaTargetDefinition,
} from "@/lib/schema-targets/catalog";
import type { FieldTypeMapping } from "../actions";

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
    "http-client-js": Code2, "http-client-python": Code2,
    "http-client-java": Code2, "http-client-csharp": Code2,
    "http-server-js": Server, "http-server-csharp": Server,
  };
  const langByKey: Record<string, string> = {
    bigquery: "sql", avro: "json", spanner: "sql", postgresql: "sql",
    openapi: "yaml", openapi3: "yaml", "json-schema": "json",
    protobuf: "text",
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
// Type override table
// ---------------------------------------------------------------------------

function TypeOverrideTable({
  fields,
  targetDisplayName,
  fieldTypeMappings,
}: {
  fields: FieldData[];
  targetDisplayName: string;
  fieldTypeMappings?: FieldTypeMapping[];
}) {
  // Use stored mappings from the generated schema version (source of truth)
  // Fall back to showing super schema type if no schema has been generated yet
  const mappingByField = new Map<string, string>();
  if (fieldTypeMappings) {
    for (const m of fieldTypeMappings) {
      mappingByField.set(m.fieldName, m.targetType);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-caption text-muted-foreground">
        Field type mappings for {targetDisplayName}.
        {!fieldTypeMappings && " Generate a schema first to see the actual target types."}
      </p>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <table className="w-full text-caption">
          <thead>
            <tr className="bg-muted/30 border-b border-border/50">
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px]">Field</th>
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px]">Super Schema Type</th>
              <th className="text-left px-3 py-2 font-semibold text-foreground/80 uppercase tracking-wider text-[10px]">{targetDisplayName} Type</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, i) => {
              const targetType = mappingByField.get(field.name) ?? field.type;
              return (
                <tr key={field.id} className={i % 2 === 0 ? "" : "bg-muted/10"}>
                  <td className="px-3 py-1.5 font-mono text-foreground">{field.name}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{field.type}</td>
                  <td className={`px-3 py-1.5 font-mono ${fieldTypeMappings ? "text-primary" : "text-muted-foreground/50 italic"}`}>{targetType}</td>
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
// SchemasTab — vertical technology tabs + horizontal schema/overrides tabs
// ---------------------------------------------------------------------------

type ContentTab = "schema" | "overrides";

export function SchemasTab({ entityId, entityName, fields, entity }: SchemasTabProps) {
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersionsMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [contentTab, setContentTab] = useState<ContentTab>("schema");
  const [isGenerating, setIsGenerating] = useState(false);

  const loadVersions = useCallback(async () => {
    const result = await getSchemaVersionsAction(entityId);
    if (result.schemaVersions) {
      setSchemaVersions(result.schemaVersions);
    }
    setIsLoading(false);
  }, [entityId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // Build target list from catalog
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

  // Auto-select first target with versions, or first available
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
      toast.success(`${getTargetMeta(targetKey).displayName} generated`);
      await loadVersions();
    } catch { toast.error("Generation failed"); }
    finally { setIsGenerating(false); }
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
              {/* Horizontal tabs: Schema | Type Overrides */}
              <div className="flex items-center justify-between border-b border-border/50 mb-space-3">
                <div className="flex gap-1">
                  <button
                    onClick={() => setContentTab("schema")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "schema"
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Generated Schema
                  </button>
                  <button
                    onClick={() => setContentTab("overrides")}
                    className={`px-3 py-1.5 text-body-small font-medium border-b-2 -mb-px transition-colors ${
                      contentTab === "overrides"
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Target Type Overrides
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={isGenerating || fields.length === 0}
                  onClick={() => handleGenerate(selected.key)}
                >
                  {isGenerating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Zap className="w-3.5 h-3.5" />
                  )}
                  {latestVersion ? "Regenerate" : "Generate"}
                </Button>
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

              {/* Type overrides content */}
              {contentTab === "overrides" && (
                <TypeOverrideTable
                  fields={fields}
                  targetDisplayName={selected.displayName}
                  fieldTypeMappings={latestVersion?.fieldTypeMappings}
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
