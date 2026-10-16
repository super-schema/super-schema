"use client";

// src/features/events/builder/template/controls/EntityPinControl.tsx
// kind "entityPin": the existing entity + published-version picker, loaded lazily so the server-action module behind it stays out of
// every module graph that merely imports the form (same pattern as MessagesSection). Optional unless the field is required.
import { lazy, Suspense } from "react";
import type { EntityOption } from "@/features/events/shared/EntityPinPicker";
import type { EntityPin } from "@/lib/events/types";
import type { ControlProps } from "./types";

const EntityPinPicker = lazy(() => import("@/features/events/shared/EntityPinPicker").then((m) => ({ default: m.EntityPinPicker })));

const NO_ENTITIES: EntityOption[] = [];

const isPin = (v: unknown): v is EntityPin => typeof v === "object" && v !== null && typeof (v as EntityPin).entityId === "string";

export function EntityPinControl({ field, id, value, onChange, disabled, required, describedBy, context }: ControlProps) {
  return (
    <div role="group" data-testid={id} aria-describedby={describedBy} className="space-y-space-1">
      <Suspense fallback={<p data-testid={`${id}-loading`} className="text-caption text-muted-foreground">{`${field.label}: loading…`}</p>}>
        <EntityPinPicker
          id={id} label={field.label} optional={!required} entities={context?.entityOptions ?? NO_ENTITIES} value={isPin(value) ? value : null}
          loadVersions={context?.loadVersions} disabled={disabled} onChange={(pin) => onChange(pin ?? undefined)}
        />
      </Suspense>
    </div>
  );
}
