"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Activity,
  Database,
  Cpu,
  Zap,
  Users,
  Layers,
  Globe,
  FileText,
  AlertTriangle,
} from "lucide-react";
import type {
  ComponentStatus,
  UsageMetrics,
  ActivityMetrics,
  ErrorSummary,
} from "@/types/schemas/health";
import { getHealthAction } from "@/app/(dashboard)/admin/actions";

type StatusColor = "green" | "amber" | "red";

function statusToColor(status: string): StatusColor {
  if (status === "healthy") return "green";
  if (status === "degraded") return "amber";
  return "red";
}

function StatusIndicator({ status }: { status: StatusColor }) {
  const colors = {
    green: "bg-success",
    amber: "bg-warning",
    red: "bg-destructive",
  };
  return (
    <span className={`w-3 h-3 rounded-full ${colors[status]} inline-block`} />
  );
}

export function HealthDashboard() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [components, setComponents] = useState<{
    database: ComponentStatus;
    compiler: ComponentStatus;
    emitters: ComponentStatus;
  } | null>(null);
  const [usage, setUsage] = useState<UsageMetrics | null>(null);
  const [activity, setActivity] = useState<ActivityMetrics | null>(null);
  const [errors, setErrors] = useState<ErrorSummary | null>(null);

  const load = useCallback(async () => {
    const res = await getHealthAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      setLoading(false);
      return;
    }
    setError(null);
    setComponents(res.data.health.components);
    setUsage(res.data.usage);
    setActivity(res.data.activity);
    setErrors(res.data.errors);
    setLoading(false);
  }, []);

  function refresh() {
    setLoading(true);
    setError(null);
    void load();
  }

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const usageCards = [
    { label: "Total Entities", value: usage?.totalEntities ?? 0, icon: Layers },
    { label: "Total Fields", value: usage?.totalFields ?? 0, icon: FileText },
    { label: "Total Domains", value: usage?.totalDomains ?? 0, icon: Globe },
    { label: "Total Users", value: usage?.totalUsers ?? 0, icon: Users },
    { label: "Total Emissions", value: usage?.totalEmissions ?? 0, icon: Zap },
  ];
  const activityCards = [
    { label: "Active Users", value: activity?.activeUsers24h ?? 0 },
    { label: "Emissions Today", value: activity?.emissionsToday ?? 0 },
    { label: "Schema Changes", value: activity?.schemaChangesToday ?? 0 },
    { label: "Pending Governance", value: activity?.governanceRequestsPending ?? 0, highlight: true },
  ];
  const errorCards = [
    { label: "Compilation Errors", value: errors?.compilationErrors24h ?? 0 },
    { label: "Emission Failures", value: errors?.emissionValidationFailures24h ?? 0 },
  ];

  return (
    <div className="space-y-space-6">
      {error && (
        <div
          role="alert"
          data-testid="health-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}
      {/* Actions */}
      <div className="flex items-center gap-space-3">
        <button
          onClick={refresh}
          disabled={loading}
          data-testid="health-run-check"
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small disabled:opacity-50"
        >
          <Activity className="w-4 h-4" />
          Run Health Check
        </button>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md border border-border text-body-small text-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Service Status */}
      <section>
        <h3 className="text-heading-4 text-foreground mb-space-3">Service Status</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-4">
          {[
            { key: "database" as const, icon: Database, label: "Database" },
            { key: "compiler" as const, icon: Cpu, label: "TypeSpec Compiler" },
            { key: "emitters" as const, icon: Zap, label: "Emitters" },
          ].map(({ key, icon: Icon, label }) => {
            const comp = components?.[key] ?? {
              name: label,
              status: loading ? "degraded" : "unhealthy",
              message: loading ? "Checking\u2026" : "Unknown",
            };
            return (
              <div
                key={key}
                data-testid="health-service"
                data-service={key}
                data-status={comp.status}
                className="border border-border rounded-lg p-space-4"
              >
                <div className="flex items-center justify-between mb-space-2">
                  <div className="flex items-center gap-space-2">
                    <Icon className="w-5 h-5 text-muted-foreground" />
                    <span className="text-body text-foreground">{label}</span>
                  </div>
                  <StatusIndicator status={statusToColor(comp.status)} />
                </div>
                <p className="text-body-small text-muted-foreground">{comp.message}</p>
                {comp.latencyMs !== undefined && (
                  <p className="text-caption text-muted-foreground mt-1">{comp.latencyMs}ms</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Usage Metrics */}
      <section>
        <h3 className="text-heading-4 text-foreground mb-space-3">Usage Metrics</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-space-4">
          {usageCards.map(({ label, value, icon: Icon }) => (
            <div key={label} data-testid="health-usage" data-metric={label} className="border border-border rounded-lg p-space-4 text-center">
              <Icon className="w-5 h-5 text-muted-foreground mx-auto mb-space-2" />
              <p className="text-heading-2 text-foreground">{value}</p>
              <p className="text-caption text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Activity Metrics */}
      <section>
        <h3 className="text-heading-4 text-foreground mb-space-3">Activity (24h)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-space-4">
          {activityCards.map(({ label, value, highlight }) => (
            <div
              key={label}
              className={`border rounded-lg p-space-4 text-center ${
                highlight && value > 0
                  ? "border-warning bg-warning/5"
                  : "border-border"
              }`}
            >
              <p className="text-heading-3 text-foreground">{value}</p>
              <p className="text-caption text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Error Summary */}
      <section>
        <h3 className="text-heading-4 text-foreground mb-space-3">Errors (24h)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-4">
          {errorCards.map(({ label, value }) => (
            <div
              key={label}
              className={`border rounded-lg p-space-4 text-center cursor-pointer hover:border-primary/30 transition-colors ${
                value > 0 ? "border-destructive bg-destructive/5" : "border-border"
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 mx-auto mb-space-2 ${
                  value > 0 ? "text-destructive" : "text-muted-foreground"
                }`}
              />
              <p className={`text-heading-3 ${value > 0 ? "text-destructive" : "text-foreground"}`}>
                {value}
              </p>
              <p className="text-caption text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
