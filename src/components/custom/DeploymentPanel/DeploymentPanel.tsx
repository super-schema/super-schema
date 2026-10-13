"use client";

import { useState } from "react";
import { RefreshCw, Rocket } from "lucide-react";
import { DriftBadge } from "@/components/custom/DriftBadge/DriftBadge";
import { VersionBadge } from "./VersionBadge";
import { MarkAsDeployedDialog } from "./MarkAsDeployedDialog";
import type { DeploymentStatus } from "@/services/deployment.service";
import { formatDateOnly } from "@/lib/date-format";

interface DeploymentPanelProps {
  entityName: string;
  deploymentStatuses: DeploymentStatus[];
  onCheckDrift?: (targetId: string) => void;
  onMarkDeployed?: (targetId: string, environment: string) => void;
  isChecking?: boolean;
}

export function DeploymentPanel({
  entityName,
  deploymentStatuses,
  onCheckDrift,
  onMarkDeployed,
  isChecking = false,
}: DeploymentPanelProps) {
  const [deployDialog, setDeployDialog] = useState<{
    targetId: string;
    targetFormat: string;
    version: string;
  } | null>(null);

  return (
    <div data-testid="deployment-panel" className="flex flex-col gap-space-3">
      <h4 className="text-caption text-muted-foreground uppercase tracking-wider">
        Deployment Status
      </h4>

      {deploymentStatuses.length === 0 && (
        <p className="text-caption text-muted-foreground">
          No emission targets configured. Add targets to track deployments.
        </p>
      )}

      {deploymentStatuses.map((target) => (
        <div
          key={target.targetId}
          className="border border-border rounded-lg overflow-hidden"
        >
          {/* Target header */}
          <div className="flex items-center gap-space-2 px-space-3 py-2 surface-1">
            <span className="text-body-small font-medium text-foreground flex-1">
              {target.targetFormat}
            </span>
            <div className="flex items-center gap-space-2">
              <span className="text-caption text-muted-foreground">
                Emitted:
              </span>
              <VersionBadge version={target.emittedVersion} />
            </div>
            <div className="flex items-center gap-1">
              {onCheckDrift && (
                <button
                  onClick={() => onCheckDrift(target.targetId)}
                  disabled={isChecking}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground disabled:opacity-50"
                  title="Check Drift"
                >
                  <RefreshCw
                    className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`}
                  />
                </button>
              )}
              {onMarkDeployed && (
                <button
                  onClick={() =>
                    setDeployDialog({
                      targetId: target.targetId,
                      targetFormat: target.targetFormat,
                      version: target.emittedVersion || "v0",
                    })
                  }
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                  title="Mark as Deployed"
                >
                  <Rocket className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Environments */}
          {target.environments.length > 0 ? (
            <div className="divide-y divide-border">
              {target.environments.map((env) => (
                <div
                  key={env.name}
                  className="flex items-center gap-space-2 px-space-3 py-1.5"
                >
                  <span className="text-caption text-muted-foreground w-24">
                    {env.name}
                  </span>
                  <VersionBadge
                    version={env.deployedVersion}
                    isMatched={
                      env.deployedVersion === target.emittedVersion
                    }
                    label={`Deployed to ${env.name}`}
                  />
                  <DriftBadge status={env.driftStatus} compact />
                  {env.lastChecked && (
                    <span className="text-caption text-muted-foreground ml-auto">
                      {formatDateOnly(env.lastChecked)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-space-3 py-1.5">
              <span className="text-caption text-muted-foreground">
                Not tracked in any environment
              </span>
            </div>
          )}
        </div>
      ))}

      {/* Mark as Deployed dialog */}
      {deployDialog && (
        <MarkAsDeployedDialog
          isOpen={true}
          onClose={() => setDeployDialog(null)}
          onConfirm={(environment) => {
            onMarkDeployed?.(deployDialog.targetId, environment);
            setDeployDialog(null);
          }}
          targetFormat={deployDialog.targetFormat}
          version={deployDialog.version}
          entityName={entityName}
        />
      )}
    </div>
  );
}
