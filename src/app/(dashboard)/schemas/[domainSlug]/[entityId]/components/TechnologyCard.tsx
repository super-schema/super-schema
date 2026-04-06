"use client";

import { useState, useCallback } from "react";
import {
  Loader2,
  Zap,
  ChevronDown,
  ChevronRight,
  Send,
  Rocket,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  generateSchemaAction,
  publishSchemaAction,
  deploySchemaAction,
} from "../actions";
import type { SchemaVersion } from "../actions";
import { StatusBadge } from "./SchemaVersionList";
import { SchemaVersionList } from "./SchemaVersionList";
import { SchemaCodePreview } from "./SchemaCodePreview";

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
// Types
// ---------------------------------------------------------------------------

export interface TargetInfo {
  key: string;
  displayName: string;
  icon: React.ReactNode;
}

interface TechnologyCardProps {
  targetInfo: TargetInfo;
  versions: SchemaVersion[];
  entityId: string;
  entityVersion: number;
  fieldsCount: number;
  onVersionsChange: () => void;
}

// ---------------------------------------------------------------------------
// TechnologyCard
// ---------------------------------------------------------------------------

export function TechnologyCard({
  targetInfo,
  versions,
  entityId,
  entityVersion,
  fieldsCount,
  onVersionsChange,
}: TechnologyCardProps) {
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
              <SchemaVersionList
                versions={versions}
                activeVersion={displayVersion?.version ?? null}
                onSelectVersion={setViewingVersion}
              />

              {/* Preview of selected version */}
              {displayVersion && (
                <div className="space-y-space-3">
                  <SchemaCodePreview
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
