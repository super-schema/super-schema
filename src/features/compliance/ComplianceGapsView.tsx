"use client";

import { useRouter } from "next/navigation";
import { ShieldAlert, CheckCircle } from "lucide-react";
import type { ComplianceGap, GapSummary } from "@/types/schemas/compliance";

interface ComplianceGapsViewProps {
  gaps: ComplianceGap[];
  summary: GapSummary;
  loading: boolean;
}

const GAP_TYPE_LABELS: Record<string, string> = {
  PII_NO_ANONYMIZATION: "PII No Anonymization",
  SENSITIVE_NO_ENCRYPTION: "Sensitive No Encryption",
  UNCLASSIFIED: "Unclassified",
  NO_RETENTION: "No Retention",
};

const GAP_TYPE_COLORS: Record<string, string> = {
  PII_NO_ANONYMIZATION: "bg-red-500/20 text-red-400",
  SENSITIVE_NO_ENCRYPTION: "bg-amber-500/20 text-amber-400",
  UNCLASSIFIED: "bg-red-500/20 text-red-400",
  NO_RETENTION: "bg-amber-500/20 text-amber-400",
};

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-500/20 text-red-400",
  WARNING: "bg-amber-500/20 text-amber-400",
};

function GapPanelForType(gapType: string): string {
  switch (gapType) {
    case "PII_NO_ANONYMIZATION":
    case "NO_RETENTION":
      return "policy";
    case "SENSITIVE_NO_ENCRYPTION":
      return "policy";
    case "UNCLASSIFIED":
      return "classification";
    default:
      return "classification";
  }
}

export function ComplianceGapsView({
  gaps,
  summary,
  loading,
}: ComplianceGapsViewProps) {
  const router = useRouter();

  if (loading) {
    return (
      <div className="flex-1 p-space-6">
        <div className="h-16 bg-muted rounded-xl animate-pulse mb-space-4" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-10 bg-muted rounded animate-pulse mb-space-2"
          />
        ))}
      </div>
    );
  }

  if (gaps.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-space-4 text-center p-space-8"
        data-testid="gaps-empty-state"
      >
        <CheckCircle className="w-12 h-12 text-green-400" />
        <div>
          <h3 className="text-body text-foreground font-medium">
            No compliance gaps detected
          </h3>
          <p className="text-body-small text-muted-foreground mt-space-1">
            All fields are properly classified and configured.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="compliance-gaps-view">
      {/* Summary bar */}
      <div className="mx-space-4 mt-space-4 p-space-4 rounded-xl surface-1 border border-border backdrop-blur-sm">
        <div className="flex items-center gap-space-4">
          <ShieldAlert className="w-5 h-5 text-red-400" />
          <span className="text-body font-medium text-foreground">
            {summary.criticalCount} critical gap{summary.criticalCount !== 1 ? "s" : ""},{" "}
            {summary.warningCount} warning{summary.warningCount !== 1 ? "s" : ""} across{" "}
            {summary.affectedEntityCount} entit{summary.affectedEntityCount !== 1 ? "ies" : "y"}
          </span>
          <div className="flex gap-space-2 ml-auto">
            {Object.entries(summary.countsByGapType).map(([type, count]) => (
              <span
                key={type}
                className={`inline-block px-2 py-0.5 rounded text-caption font-medium ${GAP_TYPE_COLORS[type] || "bg-muted text-muted-foreground"}`}
              >
                {GAP_TYPE_LABELS[type] || type}: {count}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Gap table */}
      <div className="flex-1 overflow-auto mt-space-4">
        <table className="w-full text-body-small">
          <thead className="sticky top-0 surface-1 border-b border-border">
            <tr>
              <th className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider">
                Entity
              </th>
              <th className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider">
                Field
              </th>
              <th className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider">
                Gap Type
              </th>
              <th className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider">
                Severity
              </th>
              <th className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider">
                Suggested Fix
              </th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((gap, i) => (
              <tr
                key={`${gap.fieldId}-${gap.gapType}-${i}`}
                className="border-b border-border/50 hover:bg-accent/30 cursor-pointer transition-colors"
                onClick={() =>
                  router.push(
                    gap.domainSlug && gap.productSlug
                      ? `/schemas/${gap.domainSlug}/${gap.productSlug}/${gap.entitySlug || gap.entityId}?fieldId=${gap.fieldId}&panel=${GapPanelForType(gap.gapType)}`
                      : `/schemas?entityId=${encodeURIComponent(gap.entityId)}&fieldId=${gap.fieldId}&panel=${GapPanelForType(gap.gapType)}`
                  )
                }
              >
                <td className="px-space-3 py-space-2 font-mono text-primary">
                  {gap.entityName}
                </td>
                <td className="px-space-3 py-space-2 font-mono">
                  {gap.fieldName}
                </td>
                <td className="px-space-3 py-space-2">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-caption font-medium ${GAP_TYPE_COLORS[gap.gapType] || "bg-muted text-muted-foreground"}`}
                  >
                    {GAP_TYPE_LABELS[gap.gapType] || gap.gapType}
                  </span>
                </td>
                <td className="px-space-3 py-space-2">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-caption font-medium ${SEVERITY_COLORS[gap.severity]}`}
                  >
                    {gap.severity}
                  </span>
                </td>
                <td className="px-space-3 py-space-2 text-muted-foreground">
                  {gap.suggestedFix}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
