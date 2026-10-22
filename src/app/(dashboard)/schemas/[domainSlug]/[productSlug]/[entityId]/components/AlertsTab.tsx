"use client";

import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { EntityAlert } from "@/lib/validation/entity-alerts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AlertsTabProps {
  alerts: EntityAlert[];
  onNavigateToField: (fieldId: string) => void;
  onNavigateToTab: (tab: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AlertsTab({ alerts, onNavigateToField, onNavigateToTab }: AlertsTabProps) {
  const errorCount = alerts.filter((a) => a.severity === "error").length;
  const warningCount = alerts.filter((a) => a.severity === "warning").length;

  const entityAlerts = alerts.filter((a) => a.category === "entity");
  const fieldAlerts = alerts.filter((a) => a.category === "field");
  const targetAlerts = alerts.filter((a) => a.category === "target");

  // --- Empty state ---
  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="w-10 h-10 text-green-500 mb-space-3" />
        <h3 className="text-heading-3 text-foreground mb-space-1">No alerts</h3>
        <p className="text-body-small text-muted-foreground">
          This entity meets all completeness requirements.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-6">
      {/* Summary bar */}
      <div className="flex items-center gap-space-4 rounded-lg border border-border/50 px-space-4 py-space-3 bg-muted/30">
        {errorCount > 0 && (
          <span className="flex items-center gap-1 text-body-small font-medium text-red-500">
            <AlertCircle className="w-4 h-4" />
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1 text-body-small font-medium text-amber-500">
            <AlertTriangle className="w-4 h-4" />
            {warningCount} warning{warningCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Entity-level alerts */}
      {entityAlerts.length > 0 && (
        <div>
          <h3 className="text-heading-3 text-foreground mb-space-3">Entity</h3>
          <div className="space-y-space-2">
            {entityAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAction={() => handleEntityAction(alert, onNavigateToTab)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Field-level alerts */}
      {fieldAlerts.length > 0 && (
        <div>
          <h3 className="text-heading-3 text-foreground mb-space-3">Fields</h3>
          <div className="space-y-space-2">
            {fieldAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAction={() => {
                  if (alert.fieldId) {
                    onNavigateToField(alert.fieldId);
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}

      {targetAlerts.length > 0 && (
        <div>
          <h3 className="text-heading-3 text-foreground mb-space-3">Target Drift</h3>
          <div className="space-y-space-2">
            {targetAlerts.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAction={() => onNavigateToTab("schemas")}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert Card
// ---------------------------------------------------------------------------

function AlertCard({ alert, onAction }: { alert: EntityAlert; onAction: () => void }) {
  const isError = alert.severity === "error";

  return (
    <div className="flex items-start gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3">
      {/* Severity icon */}
      {isError ? (
        <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-body-small font-medium text-foreground">{alert.title}</p>
        <p className="text-caption text-muted-foreground mt-0.5">{alert.description}</p>
      </div>

      {/* Action button */}
      <button
        onClick={onAction}
        className="shrink-0 px-space-3 py-1 rounded-md text-caption font-medium text-primary hover:bg-primary/10 transition-colors"
      >
        {alert.action}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action routing
// ---------------------------------------------------------------------------

function handleEntityAction(alert: EntityAlert, onNavigateToTab: (tab: string) => void) {
  switch (alert.id) {
    case "entity-retention":
      onNavigateToTab("governance");
      break;
    case "entity-unresolved-references":
      onNavigateToTab("editor");
      break;
    case "entity-owner":
    case "entity-description":
    case "entity-tags":
      // Scroll to the inline meta section at the top of the page
      const metaEl = document.querySelector('[data-testid="inline-entity-meta"]');
      if (metaEl) {
        metaEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      break;
    default:
      break;
  }
}
