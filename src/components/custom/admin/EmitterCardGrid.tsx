"use client";

import { useState, useEffect, useCallback } from "react";
import { Zap, ZapOff, Clock, Hash, RefreshCw } from "lucide-react";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import {
  getEmitterConfigsAction,
  updateEmitterConfigAction,
} from "@/app/(dashboard)/admin/actions";

interface EmitterCard {
  emitterName: string;
  enabled: boolean;
  version: string;
  targetFormat: string;
  description: string;
  lastEmissionAt: string | null;
  totalEmissions: number;
  sourceLabel: string;
  stability: string;
}

// Catalog supplies presentation metadata (source, stability) not stored on the
// emitter-config record; we enrich the persisted config with it by key.
const CATALOG_META = new Map(
  getSchemaTargetCatalog().map((target) => [
    target.key,
    {
      sourceLabel:
        target.source === "typespec-official" ? "Official TypeSpec" : "Super Schema",
      stability: target.stability,
    },
  ])
);

export function EmitterCardGrid() {
  const [emitters, setEmitters] = useState<EmitterCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getEmitterConfigsAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      setLoading(false);
      return;
    }
    setEmitters(
      res.data.map((c) => {
        const meta = CATALOG_META.get(c.emitterName);
        return {
          emitterName: c.emitterName,
          enabled: c.enabled,
          version: c.version,
          targetFormat: c.targetFormat,
          description: c.description,
          lastEmissionAt: c.lastEmissionAt
            ? new Date(c.lastEmissionAt).toLocaleString()
            : null,
          totalEmissions: c.totalEmissions,
          sourceLabel: meta?.sourceLabel ?? "Super Schema",
          stability: meta?.stability ?? "stable",
        };
      })
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function toggleEmitter(name: string, next: boolean) {
    setBusy(name);
    setError(null);
    // optimistic
    setEmitters((prev) =>
      prev.map((e) => (e.emitterName === name ? { ...e, enabled: next } : e))
    );
    const res = await updateEmitterConfigAction({ emitterName: name, enabled: next });
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      // revert
      setEmitters((prev) =>
        prev.map((e) => (e.emitterName === name ? { ...e, enabled: !next } : e))
      );
    }
    setBusy(null);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-space-2 text-body-small text-muted-foreground py-space-6">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading emitters…
      </div>
    );
  }

  return (
    <div className="space-y-space-4">
      {error && (
        <div
          role="alert"
          data-testid="emitter-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

      {emitters.length === 0 ? (
        <div className="border border-border rounded-lg px-space-4 py-space-6 text-center text-body-small text-muted-foreground">
          No emitters configured.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-4">
          {emitters.map((emitter) => (
            <div
              key={emitter.emitterName}
              data-testid="emitter-card"
              data-emitter={emitter.emitterName}
              data-enabled={emitter.enabled ? "true" : "false"}
              className="border border-border rounded-lg p-space-4"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-space-3">
                <div className="flex items-center gap-space-2">
                  {emitter.enabled ? (
                    <Zap className="w-5 h-5 text-primary" />
                  ) : (
                    <ZapOff className="w-5 h-5 text-muted-foreground" />
                  )}
                  <h3 className="text-heading-4 text-foreground capitalize">
                    {emitter.emitterName}
                  </h3>
                </div>

                {/* Toggle */}
                <button
                  data-testid="emitter-toggle"
                  onClick={() => toggleEmitter(emitter.emitterName, !emitter.enabled)}
                  disabled={busy === emitter.emitterName}
                  className={`relative w-10 h-5 rounded-full transition-colors disabled:opacity-50 ${
                    emitter.enabled ? "bg-success" : "bg-muted"
                  }`}
                  title={emitter.enabled ? "Disable emitter" : "Enable emitter"}
                  aria-pressed={emitter.enabled}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                      emitter.enabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Info */}
              <p className="text-body-small text-muted-foreground mb-space-3">
                {emitter.description}
              </p>

              <div className="flex items-center gap-space-4 text-caption text-muted-foreground">
                <span>v{emitter.version}</span>
                <span className="px-1.5 py-0.5 rounded bg-muted">{emitter.targetFormat}</span>
                <span className="px-1.5 py-0.5 rounded bg-muted/60">{emitter.sourceLabel}</span>
                <span className="px-1.5 py-0.5 rounded bg-muted/60 uppercase">{emitter.stability}</span>
              </div>

              {/* Status badge */}
              <div className="mt-space-3 flex items-center justify-between">
                <span
                  data-testid="emitter-status"
                  className={`inline-flex px-2 py-0.5 rounded-full text-caption ${
                    emitter.enabled
                      ? "bg-success/20 text-success"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {emitter.enabled ? "Enabled" : "Disabled"}
                </span>

                <div className="flex items-center gap-space-3 text-caption text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Hash className="w-3 h-3" />
                    {emitter.totalEmissions}
                  </span>
                  {emitter.lastEmissionAt && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {emitter.lastEmissionAt}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
