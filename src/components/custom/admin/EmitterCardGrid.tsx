"use client";

import { useState } from "react";
import { Zap, ZapOff, Clock, Hash, ChevronRight } from "lucide-react";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";

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

const DEFAULT_EMITTERS: EmitterCard[] = getSchemaTargetCatalog().map((target) => ({
  emitterName: target.key,
  enabled: target.enabledInSchemaTab,
  version: target.packageName ? "npm" : "1.0.0",
  targetFormat: target.targetFormat,
  description: target.description,
  lastEmissionAt: null,
  totalEmissions: 0,
  sourceLabel: target.source === "typespec-official" ? "Official TypeSpec" : "Super Schema",
  stability: target.stability,
}));

export function EmitterCardGrid() {
  const [emitters, setEmitters] = useState<EmitterCard[]>(DEFAULT_EMITTERS);

  function toggleEmitter(name: string) {
    setEmitters((prev) =>
      prev.map((e) =>
        e.emitterName === name ? { ...e, enabled: !e.enabled } : e
      )
    );
    // In production, call oRPC mutation
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-4">
      {emitters.map((emitter) => (
        <div
          key={emitter.emitterName}
          className="border border-border rounded-lg p-space-4 hover:border-primary/30 transition-colors cursor-pointer"
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
              onClick={(e) => {
                e.stopPropagation();
                toggleEmitter(emitter.emitterName);
              }}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                emitter.enabled ? "bg-success" : "bg-muted"
              }`}
              title={emitter.enabled ? "Disable emitter" : "Enable emitter"}
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

          {/* View details */}
          <div className="mt-space-3 pt-space-3 border-t border-border">
            <span className="flex items-center gap-1 text-caption text-primary">
              View details
              <ChevronRight className="w-3 h-3" />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
