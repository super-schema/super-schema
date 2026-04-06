"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Zap,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Send,
  Rocket,
  Database,
  FileJson,
  Globe,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  generateSchemaAction,
  publishSchemaAction,
  deploySchemaAction,
  getSchemaVersionsAction,
} from "../actions";
import type { SchemaVersion, SchemaVersionsMap } from "../actions";

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

// ---------------------------------------------------------------------------
// Target metadata (icon, display name)
// ---------------------------------------------------------------------------

interface TargetInfo {
  key: string;
  displayName: string;
  icon: React.ReactNode;
}

const TARGET_INFO: Record<string, { displayName: string; iconComponent: typeof Database }> = {
  bigquery: { displayName: "BigQuery DDL", iconComponent: Database },
  avro: { displayName: "Avro Schema", iconComponent: FileJson },
  openapi: { displayName: "OpenAPI 3.1", iconComponent: Globe },
};

function getTargetInfo(key: string): TargetInfo {
  const info = TARGET_INFO[key];
  const IconComponent = info?.iconComponent ?? FileJson;
  return {
    key,
    displayName: info?.displayName ?? key,
    icon: <IconComponent className="w-4 h-4" />,
  };
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: SchemaVersion["status"] }) {
  const styles: Record<string, string> = {
    draft: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    published: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    deployed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  };

  const labels: Record<string, string> = {
    draft: "Draft",
    published: "Published",
    deployed: "Deployed",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status dot indicator
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: SchemaVersion["status"] }) {
  const colors: Record<string, string> = {
    draft: "bg-amber-500",
    published: "bg-blue-500",
    deployed: "bg-green-500",
  };

  const labels: Record<string, string> = {
    draft: "Draft (not yet published)",
    published: "Published (ready for deployment)",
    deployed: "Deployed to production",
  };

  return (
    <div className="flex items-center gap-space-2 text-caption text-muted-foreground">
      <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-gray-400"}`} />
      {labels[status] ?? status}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Code preview with line numbers and copy
// ---------------------------------------------------------------------------

function CodePreview({
  code,
  onCopy,
}: {
  code: string;
  onCopy: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    onCopy();
    setTimeout(() => setCopied(false), 2000);
  }, [code, onCopy]);

  return (
    <div className="relative rounded-md border border-border/50 bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between px-space-3 py-space-1 bg-muted/30 border-b border-border/50">
        <span className="text-caption text-muted-foreground">Preview</span>
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
          title="Copy to clipboard"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-space-3 text-caption font-mono text-foreground overflow-x-auto max-h-80 overflow-y-auto">
        <code>
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="inline-block w-8 text-right pr-3 text-muted-foreground select-none">
                {i + 1}
              </span>
              <span>{line}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-technology card
// ---------------------------------------------------------------------------

function TechnologyCard({
  targetInfo,
  versions,
  entityId,
  entityVersion,
  fieldsCount,
  onVersionsChange,
}: {
  targetInfo: TargetInfo;
  versions: SchemaVersion[];
  entityId: string;
  entityVersion: number;
  fieldsCount: number;
  onVersionsChange: () => void;
}) {
  const [expanded, setExpanded] = useState(versions.length > 0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const latestVersion = versions.length > 0 ? versions[0] : null;
  const displayVersion =
    viewingVersion != null
      ? versions.find((v) => v.version === viewingVersion)
      : latestVersion;

  // Check if entity has changed since last generation
  const hasChangedSinceLastGen =
    !latestVersion || latestVersion.entityVersion !== entityVersion;

  const handleGenerate = useCallback(async () => {
    if (fieldsCount === 0) {
      toast.error("Add fields before generating schemas");
      return;
    }
    setIsGenerating(true);
    try {
      const result = await generateSchemaAction(entityId, targetInfo.key);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${targetInfo.displayName} v${result.schemaVersion?.version} generated`
      );
      setViewingVersion(null);
      onVersionsChange();
    } catch {
      toast.error("Generation failed unexpectedly");
    } finally {
      setIsGenerating(false);
    }
  }, [entityId, targetInfo, fieldsCount, onVersionsChange]);

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
        onVersionsChange();
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
        onVersionsChange();
      } catch {
        toast.error("Deploy failed");
      } finally {
        setActionPending(null);
      }
    },
    [entityId, targetInfo, onVersionsChange]
  );

  return (
    <div
      className="rounded-lg border border-border/50 overflow-hidden"
      data-testid={`schema-card-${targetInfo.key}`}
    >
      {/* Card header */}
      <div
        className="flex items-center justify-between px-space-4 py-space-3 bg-muted/20 cursor-pointer select-none"
        onClick={() => setExpanded((e) => !e)}
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
          {latestVersion && (
            <StatusBadge status={latestVersion.status} />
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isGenerating || fieldsCount === 0}
          onClick={(e) => {
            e.stopPropagation();
            handleGenerate();
          }}
          data-testid={`generate-${targetInfo.key}`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5" />
              Generate
            </>
          )}
        </Button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-space-4 py-space-4 space-y-space-4">
          {versions.length === 0 ? (
            <p className="text-body-small text-muted-foreground text-center py-space-6">
              No schemas generated yet. Click Generate to create the first schema.
            </p>
          ) : (
            <>
              {/* No-change notice */}
              {!hasChangedSinceLastGen && (
                <p className="text-caption text-muted-foreground italic">
                  No changes since last schema generation (entity v{entityVersion}).
                </p>
              )}

              {/* Version history */}
              <div>
                <h4 className="text-caption font-medium text-muted-foreground mb-space-2">
                  Version History
                </h4>
                <div className="space-y-space-1">
                  {versions.map((v) => {
                    const timestamp =
                      v.deployedAt ?? v.publishedAt ?? v.generatedAt;
                    const label =
                      v.status === "deployed"
                        ? `Deployed ${relativeTime(v.deployedAt!)}`
                        : v.status === "published"
                          ? `Published ${relativeTime(v.publishedAt!)}`
                          : `Generated ${relativeTime(v.generatedAt)}`;

                    return (
                      <div
                        key={v.version}
                        className={`flex items-center justify-between rounded-md px-space-3 py-space-2 text-caption transition-colors ${
                          displayVersion?.version === v.version
                            ? "bg-muted/40 border border-border/50"
                            : "hover:bg-muted/20"
                        }`}
                      >
                        <div className="flex items-center gap-space-2">
                          <span className="font-medium text-foreground">
                            v{v.version}
                          </span>
                          <StatusBadge status={v.status} />
                          <span className="text-muted-foreground">{label}</span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-caption"
                          onClick={() =>
                            setViewingVersion(
                              viewingVersion === v.version ? null : v.version
                            )
                          }
                        >
                          <Eye className="w-3 h-3 mr-1" />
                          View
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Preview of selected version */}
              {displayVersion && (
                <div className="space-y-space-3">
                  <CodePreview
                    code={displayVersion.output}
                    onCopy={() =>
                      toast.success("Schema copied to clipboard")
                    }
                  />

                  {/* Action buttons */}
                  <div className="flex items-center justify-between">
                    <StatusDot status={displayVersion.status} />
                    <div className="flex items-center gap-space-2">
                      {displayVersion.status === "draft" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={actionPending === `publish-${displayVersion.version}`}
                          onClick={() => handlePublish(displayVersion.version)}
                        >
                          {actionPending === `publish-${displayVersion.version}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          Publish
                        </Button>
                      )}
                      {displayVersion.status === "published" && (
                        <Button
                          size="sm"
                          variant="default"
                          className="gap-1.5"
                          disabled={actionPending === `deploy-${displayVersion.version}`}
                          onClick={() => handleDeploy(displayVersion.version)}
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchemasTab — main export
// ---------------------------------------------------------------------------

export function SchemasTab({ entityId, entityName, fields, entity }: SchemasTabProps) {
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersionsMap>({});
  const [isLoading, setIsLoading] = useState(true);

  // Available targets (dynamically from emitter registry keys)
  const targets = ["bigquery", "avro", "openapi"];

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-space-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <span className="ml-space-2 text-body-small text-muted-foreground">
          Loading schemas...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-space-4" data-testid="schemas-tab">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-foreground">
          Schemas
        </h2>
        <span className="text-caption text-muted-foreground">
          {entityName} &middot; v{entity.version}
        </span>
      </div>

      <div className="space-y-space-3">
        {targets.map((target) => (
          <TechnologyCard
            key={target}
            targetInfo={getTargetInfo(target)}
            versions={schemaVersions[target] ?? []}
            entityId={entityId}
            entityVersion={entity.version}
            fieldsCount={fields.length}
            onVersionsChange={loadVersions}
          />
        ))}
      </div>
    </div>
  );
}
