"use client";

import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { EntityAlert } from "@/lib/validation/entity-alerts";
import { Button } from "@/components/ui/button";

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
      <div data-testid="alerts-empty" className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="w-10 h-10 text-primary mb-space-3" />
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
      <div data-testid="alerts-summary" className="flex items-center gap-space-4 rounded-lg border border-border/50 px-space-4 py-space-3 bg-muted/30">
        {errorCount > 0 && (
          <span className="flex items-center gap-1 text-body-small font-medium text-destructive">
            <AlertCircle className="w-4 h-4" />
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1 text-body-small font-medium text-warning">
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

function consequenceOf(alert: EntityAlert): string {
  if (alert.id === "entity-stale-references") return "Existing published versions stay unchanged. Review references before publishing another version.";
  if (alert.id === "entity-unresolved-references") return "Unresolved references remain untyped in generated output.";
  if (alert.category === "target") {
    if (alert.id.endsWith("-stale")) return "Review persisted overrides before regenerating this target.";
    if (alert.id.endsWith("-behind")) return "Generated output does not reflect the current entity version.";
    return "Generated field types intentionally differ from default mappings.";
  }
  if (alert.fieldName) return `Review ${alert.fieldName} so consumers can interpret and handle this field correctly.`;
  return "A configured completeness requirement is not met.";
}

function AlertCard({ alert, onAction }: { alert: EntityAlert; onAction: () => void }) {
  const isError = alert.severity === "error";

  return (
    <div
      data-testid="alert-card"
      role="group"
      aria-label={`${isError ? "Error" : "Warning"}: ${alert.title}`}
      data-alert-id={alert.id}
      data-severity={alert.severity}
      className="flex flex-wrap items-start gap-space-3 rounded-lg border border-border/50 px-space-4 py-space-3"
    >
      {/* Severity icon */}
      {isError ? (
        <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="w-4 h-4 text-warning mt-0.5 shrink-0" />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-body-small font-medium text-foreground">{alert.title}</p>
        <p className="text-caption text-muted-foreground mt-0.5">{alert.description}</p>
        {(alert.fieldName || alert.targetKey) && <p className="mt-space-1 text-caption text-muted-foreground">{alert.fieldName ? `Field: ${alert.fieldName}` : `Target: ${alert.targetKey}`}</p>}
        <p className="mt-space-1 text-caption text-muted-foreground">{consequenceOf(alert)}</p>
      </div>

      {/* Action button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onAction}
        data-testid="alert-action"
        aria-label={`${alert.action}: ${alert.fieldName ?? alert.targetKey ?? alert.title}`}
        disabled={alert.category === "field" && !alert.fieldId}
        className="shrink-0 whitespace-normal"
      >
        {alert.action}
      </Button>
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
    case "entity-stale-references":
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
