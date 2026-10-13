"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Rocket, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeploymentOverviewTable } from "@/components/custom/DeploymentOverview";
import { getDeploymentOverviewAction } from "./actions";
import type { DeploymentOverviewRow } from "@/services/deployment.service";

export default function DeploymentsPage() {
  const [rows, setRows] = useState<DeploymentOverviewRow[]>([]);
  const [targetFormats, setTargetFormats] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getDeploymentOverviewAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setTargetFormats(res.data.targetFormats);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <div className="flex-1 flex flex-col p-space-6 gap-space-4 overflow-auto">
      <div className="flex items-start justify-between gap-space-4">
        <div className="flex items-center gap-space-3">
          <div className="rounded-full bg-muted/40 p-space-2">
            <Rocket className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-heading-2 text-foreground">Deployment Tracking</h1>
            <p className="text-body-small text-muted-foreground">
              Which schema versions are deployed per target. Deploy from an entity&apos;s Schemas tab.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-space-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Link href="/schemas">
            <Button variant="outline" size="sm" className="gap-1.5">
              Go to Schemas
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="deployments-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-space-2 text-body-small text-muted-foreground py-space-6">
          <RefreshCw className="w-4 h-4 animate-spin" />
          Loading deployments…
        </div>
      ) : (
        <DeploymentOverviewTable rows={rows} targetFormats={targetFormats} />
      )}
    </div>
  );
}
