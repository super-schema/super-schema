"use client";

/**
 * ImpactReportCard
 *
 * Displays a detailed impact report in the governance dashboard.
 * Shows per-target breakdown, affected consumers, and migration artifacts.
 */

import { useState } from "react";
import type { ImpactReport } from "@/types/schemas/governance";

interface ImpactReportCardProps {
  report: ImpactReport;
}

const COMPLEXITY_STYLES: Record<string, { bg: string; text: string }> = {
  trivial: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  moderate: { bg: "bg-amber-500/20", text: "text-amber-400" },
  complex: { bg: "bg-red-500/20", text: "text-red-400" },
};

export function ImpactReportCard({ report }: ImpactReportCardProps) {
  const [showArtifacts, setShowArtifacts] = useState(false);

  return (
    <div
      data-testid="impact-report-card"
      className="rounded-lg border border-border p-4 space-y-4"
      style={{
        background: "rgba(28, 28, 38, 0.8)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* Summary */}
      <div>
        <h3 className="text-body font-semibold text-foreground mb-1">
          Impact Report
        </h3>
        <p className="text-caption text-muted-foreground">{report.summary}</p>
      </div>

      {/* Per-Target Breakdown */}
      <div>
        <h4 className="text-caption font-semibold text-foreground mb-2">
          Per-Target Compatibility
        </h4>
        <div className="space-y-1.5">
          {report.perTarget.map((pt) => {
            const compStyle = COMPLEXITY_STYLES[pt.migrationComplexity] ?? COMPLEXITY_STYLES.moderate;
            return (
              <div
                key={pt.target}
                className="flex items-center gap-3 py-1.5 px-3 rounded border border-border/50"
              >
                {/* Status icon */}
                <span
                  className={`w-4 h-4 flex items-center justify-center text-mono-small ${
                    pt.compatible
                      ? "text-emerald-400"
                      : pt.migrationRequired
                        ? "text-amber-400"
                        : "text-red-400"
                  }`}
                >
                  {pt.compatible ? "\u2713" : pt.migrationRequired ? "!" : "\u2717"}
                </span>

                {/* Target name */}
                <span className="text-caption font-medium text-foreground w-20">
                  {pt.target}
                </span>

                {/* Compatibility badge */}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${
                    pt.compatible
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {pt.compatible ? "Compatible" : "Breaking"}
                </span>

                {/* Complexity badge */}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${compStyle.bg} ${compStyle.text}`}
                >
                  {pt.migrationComplexity}
                </span>

                {/* Details */}
                <span className="text-mono-small text-muted-foreground truncate flex-1">
                  {pt.details}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Affected Consumers */}
      {report.affectedConsumers.length > 0 && (
        <div>
          <h4 className="text-caption font-semibold text-foreground mb-2">
            Affected Consumers ({report.affectedConsumers.length})
          </h4>
          <div className="space-y-1">
            {report.affectedConsumers.map((consumer, i) => (
              <div
                key={i}
                className="flex items-center gap-3 py-1 text-caption text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {consumer.entityName}
                </span>
                <span>.{consumer.fieldName}</span>
                <span className="text-mono-small opacity-70">
                  ({consumer.relationship})
                </span>
                <span className="ml-auto text-mono-small">
                  {consumer.ownerEmail || "owner not shown"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Migration Artifacts Summary */}
      <div>
        <button
          type="button"
          onClick={() => setShowArtifacts(!showArtifacts)}
          className="text-caption font-semibold text-foreground hover:text-primary transition-colors flex items-center gap-1"
        >
          <span>{showArtifacts ? "\u25BC" : "\u25B6"}</span>
          Migration Artifacts
        </button>
        {showArtifacts && (
          <div className="mt-2 space-y-1.5 pl-4">
            <div className="text-mono-small text-muted-foreground">
              <span className="font-medium text-foreground">BigQuery:</span>{" "}
              {report.migrationArtifactsSummary.bigquery}
            </div>
            <div className="text-mono-small text-muted-foreground">
              <span className="font-medium text-foreground">Avro:</span>{" "}
              {report.migrationArtifactsSummary.avro}
            </div>
            <div className="text-mono-small text-muted-foreground">
              <span className="font-medium text-foreground">OpenAPI:</span>{" "}
              {report.migrationArtifactsSummary.openapi}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
