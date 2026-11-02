"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DeploymentPanel } from "@/components/custom/DeploymentPanel/DeploymentPanel";
import type { DeploymentStatus } from "@/services/deployment.service";
import {
  getEntityDeploymentStatusAction,
  markEntityDeployedAction,
  checkTargetDriftAction,
} from "../actions";
import { errorMessage } from "@/lib/error-message";

interface EntityDeploymentsTabProps {
  entityId: string;
  entityName: string;
}

export function EntityDeploymentsTab({ entityId, entityName }: EntityDeploymentsTabProps) {
  const [statuses, setStatuses] = useState<DeploymentStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [checkingTargetId, setCheckingTargetId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await getEntityDeploymentStatusAction(entityId);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setStatuses(res.data);
    } catch (error) {
      // The spinner must end whatever the action did, or the tab reads "Loading deployments…" for the rest of the session.
      toast.error(`Could not load deployments: ${errorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }, [entityId]);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    void load();
  }, [load]);

  async function handleMarkDeployed(targetId: string, environment: string) {
    try {
      const res = await markEntityDeployedAction(entityId, targetId, environment);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Marked deployed to ${environment}`);
    } catch (error) {
      toast.error(`Could not mark deployed to ${environment}: ${errorMessage(error)}`);
      return;
    }
    await load();
  }

  async function handleCheckDrift(targetId: string) {
    setCheckingTargetId(targetId);
    try {
      const res = await checkTargetDriftAction(entityId, targetId);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setStatuses(res.data);
      toast.success("Drift check complete");
    } catch (error) {
      toast.error(`Could not check drift: ${errorMessage(error)}`);
    } finally {
      setCheckingTargetId(null);
    }
  }

  return (
    <div className="space-y-space-4" data-testid="deployments-tab">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-space-2">
          <Rocket className="w-5 h-5 text-muted-foreground" />
          <div>
            <h2 className="text-heading-2 text-foreground">Deployments</h2>
            <p className="text-caption text-muted-foreground">
              Track which emitted version is live per environment, and detect drift.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isLoading}
          onClick={() => void load()}
          data-testid="deployments-refresh"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-space-2 text-body-small text-muted-foreground py-space-6">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading deployments…
        </div>
      ) : (
        <DeploymentPanel
          entityName={entityName}
          deploymentStatuses={statuses}
          onMarkDeployed={handleMarkDeployed}
          onCheckDrift={handleCheckDrift}
          isChecking={checkingTargetId !== null}
        />
      )}
    </div>
  );
}
