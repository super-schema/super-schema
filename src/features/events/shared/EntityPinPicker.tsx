"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { listPinnableVersionsAction } from "../pin-actions";
import type { EntityPin } from "@/lib/events/types";
import type { PayloadFormat } from "@/lib/event-specs/types";

export interface EntityOption {
  id: string;
  name: string;
  ownerLabel: string;
  latestVersionId: string | null;
  latestVersionLabel: string | null;
  /** Where the entity's own page is (`assetHref`); absent when the host does not know it. */
  href?: string;
  /**
   * The representation the entity was imported in (Avro / JSON Schema / Protobuf); absent when it was not imported or came from a
   * format an event cannot emit (TypeSpec, OpenAPI, ...). What a message's "Auto" representation follows.
   */
  sourceFormat?: PayloadFormat;
}
export interface VersionOption {
  id: string;
  label: string;
}

/** Tenant-scoped server loader; an error result throws so the picker shows it instead of an empty list. */
async function defaultLoadVersions(entityId: string): Promise<VersionOption[]> {
  const r = await listPinnableVersionsAction(entityId);
  if (!r.success) throw new Error(r.error);
  return r.data;
}

type LoadedVersions = { entityId: string; options: VersionOption[] } | { entityId: string; error: string };

const selectClass = "rounded-md border border-border bg-background px-space-2 py-1 text-body-small";

/**
 * Entity + published-version picker (spec §6.1 / §9). Choosing an entity pins its latest
 * published version (D5); "Unpinned" keeps the draft for preview only. `loadVersions` must be
 * a stable function (module-level or memoized).
 */
export function EntityPinPicker({
  id, label, entities, value, onChange, optional = false, hint, loadVersions = defaultLoadVersions, disabled, autoFocus,
}: {
  id: string;
  label: string;
  entities: EntityOption[];
  value: EntityPin | null;
  onChange: (pin: EntityPin | null) => void;
  optional?: boolean;
  hint?: string;
  loadVersions?: (entityId: string) => Promise<VersionOption[]>;
  disabled?: boolean;
  /** Focus the entity select when the picker appears (a new message starts there). */
  autoFocus?: boolean;
}) {
  const entityId = value?.entityId ?? null;
  const [loaded, setLoaded] = useState<LoadedVersions | null>(null);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadVersions(entityId))
      .then((options) => {
        if (!cancelled) setLoaded({ entityId, options });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoaded({ entityId, error: e instanceof Error && e.message ? e.message : "Unexpected error" });
      });
    return () => {
      cancelled = true;
    };
  }, [entityId, loadVersions]);

  const groups = useMemo(() => {
    const byOwner = new Map<string, EntityOption[]>();
    for (const e of entities) byOwner.set(e.ownerLabel, [...(byOwner.get(e.ownerLabel) ?? []), e]);
    return [...byOwner.entries()];
  }, [entities]);

  const entity = entities.find((e) => e.id === entityId) ?? null;
  const current = loaded && loaded.entityId === entityId ? loaded : null;
  const options = current && "options" in current ? current.options : [];
  const loadError = current && "error" in current ? current.error : null;
  const pinned = value?.entityVersionId ?? null;
  const behind = pinned !== null && entity?.latestVersionId && pinned !== entity.latestVersionId;

  return (
    <fieldset className="space-y-space-1" data-testid={`${id}-picker`}>
      <legend className="text-caption text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-space-2">
        <select
          aria-label={`${label} entity`}
          className={selectClass}
          value={entityId ?? ""}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            const next = entities.find((x) => x.id === e.target.value);
            onChange(next ? { entityId: next.id, entityVersionId: next.latestVersionId } : null);
          }}
        >
          {(optional || !entityId) && <option value="">{optional ? "— none —" : "Select an entity"}</option>}
          {groups.map(([owner, items]) => (
            <optgroup key={owner} label={owner}>
              {items.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {entityId && (
          <select
            aria-label={`${label} version`}
            className={selectClass}
            value={pinned ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ entityId, entityVersionId: e.target.value || null })}
          >
            <option value="">Unpinned — preview uses the draft</option>
            {pinned && !options.some((o) => o.id === pinned) && <option value={pinned}>pinned version</option>}
            {options.map((v) => (
              <option key={v.id} value={v.id}>v{v.label}</option>
            ))}
          </select>
        )}
      </div>
      {loadError && (
        <p role="alert" className="text-caption text-destructive" data-testid={`${id}-versions-error`}>
          Could not load published versions: {loadError}
        </p>
      )}
      {behind && entity?.latestVersionLabel && (
        <Badge variant="secondary" data-testid={`${id}-newer`}>Newer version available (v{entity.latestVersionLabel})</Badge>
      )}
      {entityId && !pinned && (
        <p className="text-caption text-muted-foreground">Not pinned — publishing is blocked until a published version is pinned.</p>
      )}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}
