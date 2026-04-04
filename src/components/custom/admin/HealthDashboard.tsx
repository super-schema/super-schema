"use client";

import { useState } from "react";
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
import type { ComponentStatus } from "@/types/schemas/health";

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
  const [loading, setLoading] = useState(false);
  const [components, setComponents] = useState<{
    database: ComponentStatus;
    compiler: ComponentStatus;
    emitters: ComponentStatus;
  }>({
    database: { name: "Database", status: "healthy", message: "Connected", latencyMs: 5 },
    compiler: { name: "TypeSpec Compiler", status: "healthy", message: "Ready", latencyMs: 12 },
    emitters: { name: "Emitters", status: "healthy", message: "All operational" },
  });

  async function handleRefresh() {
    setLoading(true);
    // In production, call oRPC queries
    setTimeout(() => setLoading(false), 1000);
  }

  async function handleRunHealthCheck() {
    setLoading(true);
    // In production, call oRPC health.runCheck
    setTimeout(() => setLoading(false), 1500);
  }

  return (
    <div className="space-y-space-6">
      {/* Actions */}
      <div className="flex items-center gap-space-3">
        <button
          onClick={handleRunHealthCheck}
          disabled={loading}
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small disabled:opacity-50"
        >
          <Activity className="w-4 h-4" />
          Run Health Check
        </button>
        <button
          onClick={handleRefresh}
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
            const comp = components[key];
            return (
              <div key={key} className="border border-border rounded-lg p-space-4">
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
          {[
            { label: "Total Entities", value: 0, icon: Layers },
            { label: "Total Fields", value: 0, icon: FileText },
            { label: "Total Domains", value: 0, icon: Globe },
            { label: "Total Users", value: 0, icon: Users },
            { label: "Total Emissions", value: 0, icon: Zap },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="border border-border rounded-lg p-space-4 text-center">
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
          {[
            { label: "Active Users", value: 0 },
            { label: "Emissions Today", value: 0 },
            { label: "Schema Changes", value: 0 },
            { label: "Pending Governance", value: 0, highlight: true },
          ].map(({ label, value, highlight }) => (
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-4">
          {[
            { label: "Compilation Errors", value: 0 },
            { label: "Emission Failures", value: 0 },
            { label: "API Errors", value: 0 },
          ].map(({ label, value }) => (
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
