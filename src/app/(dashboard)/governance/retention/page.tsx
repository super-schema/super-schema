"use client";

import { Suspense, useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { RetentionPolicyEditor } from "@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor";
import {
  formatRetentionSummary,
  migrateSimpleRetention,
  type RetentionPolicy,
} from "@/types/schemas/retention-policy.schema";
import { Badge } from "@/components/ui/badge";
import {
  getEntitiesForRetentionAction,
  updateRetentionPolicyAction,
} from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntitySummary {
  id: string;
  name: string;
  domainName: string;
  retentionPolicy: RetentionPolicy | null;
  fields: { name: string; type: string }[];
  hasClassifiedFields: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RetentionPoliciesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-center text-caption text-muted-foreground">Loading...</div>}>
      <RetentionPoliciesContent />
    </Suspense>
  );
}

function RetentionPoliciesContent() {
  const searchParams = useSearchParams();
  const focusEntityId = searchParams.get("entity");

  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(focusEntityId);
  const [isLoading, setIsLoading] = useState(true);
  // The policy each entity's save is writing, from the moment Save is pressed until the server answers. The list holds the policy an entity had
  // before that save, so selecting the entity again while the save runs shows this one instead, and its Save waits for the answer: the answer
  // then cannot bring the old policy back into the form.
  const [pendingPolicies, setPendingPolicies] = useState<Map<string, RetentionPolicy>>(() => new Map());

  const loadEntities = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await getEntitiesForRetentionAction();
      if (result.error) {
        toast.error(result.error);
        return;
      }

      const mapped: EntitySummary[] = (result.entities ?? []).map((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const rawRetention = meta.retentionPolicy;

        let retentionPolicy: RetentionPolicy | null = null;
        if (rawRetention && typeof rawRetention === "object") {
          retentionPolicy = rawRetention as RetentionPolicy;
        } else if (typeof rawRetention === "string" && rawRetention) {
          retentionPolicy = migrateSimpleRetention(rawRetention);
        }

        const hasClassifiedFields = e.fields.some(
          (f) => f.classification === "PII" || f.classification === "SENSITIVE"
        );

        return {
          id: e.id,
          name: e.name,
          domainName: e.domainName,
          retentionPolicy,
          fields: e.fields.map((f) => ({ name: f.name, type: f.type })),
          hasClassifiedFields,
        };
      });
      setEntities(mapped);
    } catch {
      toast.error("Failed to load entities");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEntities();
  }, [loadEntities]);

  // The entity the URL names is selected when the URL names one (on mount, or when the link changes). Not on every change of the list: a save
  // changes the list, and that would take the selection back from the entity the user chose.
  useEffect(() => {
    if (focusEntityId) setSelectedEntityId(focusEntityId);
  }, [focusEntityId]);

  // The toasts name the entity: the selection may have moved on by the time the answer comes.
  const handleSavePolicy = useCallback(
    async (entityId: string, policy: RetentionPolicy) => {
      const name = entities.find((e) => e.id === entityId)?.name ?? "this entity";
      setPendingPolicies((prev) => new Map(prev).set(entityId, policy));
      try {
        const result = await updateRetentionPolicyAction(entityId, policy as unknown as Record<string, unknown>);

        if (result.error) {
          toast.error(`Retention policy for ${name} was not saved: ${result.error}`);
          return;
        }

        toast.success(`Retention policy saved for ${name}`);
        setEntities((prev) =>
          prev.map((e) =>
            e.id === entityId ? { ...e, retentionPolicy: policy } : e
          )
        );
      } finally {
        // Cleared with the list update above (one render), and only if this save is still the one pending for the entity.
        setPendingPolicies((prev) => {
          if (prev.get(entityId) !== policy) return prev;
          const next = new Map(prev);
          next.delete(entityId);
          return next;
        });
      }
    },
    [entities]
  );

  const selectedEntity = entities.find((e) => e.id === selectedEntityId);
  const withPolicy = entities.filter((e) => e.retentionPolicy);
  const withoutPolicy = entities.filter((e) => !e.retentionPolicy);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <Clock className="w-5 h-5 text-muted-foreground" />
          <h1 className="text-heading-1 text-foreground">Retention Policies</h1>
        </div>
        <p className="text-caption text-muted-foreground mt-1">
          Define condition-based retention policies for entity data governance
        </p>
        <div className="flex items-center gap-3 mt-2 text-caption">
          <span className="flex items-center gap-1 text-success">
            <CheckCircle2 className="w-3 h-3" />
            {withPolicy.length} configured
          </span>
          {withoutPolicy.length > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <AlertTriangle className="w-3 h-3" />
              {withoutPolicy.length} without policy
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Entity list */}
        <div className="w-[320px] border-r border-border overflow-y-auto">
          {isLoading ? (
            <div className="p-6 text-center text-caption text-muted-foreground">Loading entities...</div>
          ) : entities.length === 0 ? (
            <div className="p-6 text-center text-caption text-muted-foreground">
              No entities found. Create entities first in the Schema Editor.
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {entities.map((entity) => (
                <button
                  key={entity.id}
                  onClick={() => setSelectedEntityId(entity.id)}
                  className={`w-full text-left px-4 py-3 transition-colors ${
                    selectedEntityId === entity.id ? "bg-accent" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-body-small font-medium text-foreground">{entity.name}</span>
                    {entity.retentionPolicy ? (
                      <CheckCircle2 className="w-3 h-3 text-success shrink-0" />
                    ) : entity.hasClassifiedFields ? (
                      <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{entity.domainName}</div>
                  {entity.retentionPolicy && (
                    <Badge variant="secondary" className="text-[10px] h-4 mt-1">
                      {formatRetentionSummary(entity.retentionPolicy)}
                    </Badge>
                  )}
                  {!entity.retentionPolicy && entity.hasClassifiedFields && (
                    <span className="text-[10px] text-warning mt-1 block">
                      PII/Sensitive data — no retention policy
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editor panel */}
        <div className="flex-1 overflow-y-auto p-6">
          {selectedEntity ? (
            <RetentionPolicyEditor
              entityId={selectedEntity.id}
              entityName={selectedEntity.name}
              fields={selectedEntity.fields}
              currentPolicy={pendingPolicies.get(selectedEntity.id) ?? selectedEntity.retentionPolicy}
              saving={pendingPolicies.has(selectedEntity.id)}
              onSave={handleSavePolicy}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-caption text-muted-foreground">
              Select an entity from the list to configure its retention policy
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
