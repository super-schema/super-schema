"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { listEntityVersionsAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions";
import type { EntityPin } from "@/lib/events/types";

export interface EntityOption {
  id: string;
  name: string;
  ownerLabel: string;
  latestVersionId: string | null;
  latestVersionLabel: string | null;
}
export interface VersionOption {
  id: string;
  label: string;
}

async function defaultLoadVersions(entityId: string): Promise<VersionOption[]> {
  const r = await listEntityVersionsAction(entityId);
  return "versions" in r ? r.versions.map((v) => ({ id: v.id, label: v.label })) : [];
}

const selectClass = "rounded-md border border-border bg-background px-space-2 py-1 text-body-small";

/**
 * Entity + published-version picker (spec §6.1 / §9). Choosing an entity pins its latest
 * published version (D5); "Unpinned" keeps the draft for preview only. `loadVersions` must be
 * a stable function (module-level or memoized).
 */
export function EntityPinPicker({
  id, label, entities, value, onChange, optional = false, hint, loadVersions = defaultLoadVersions, disabled,
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
}) {
  const entityId = value?.entityId ?? null;
  const [loaded, setLoaded] = useState<{ entityId: string; options: VersionOption[] } | null>(null);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    void loadVersions(entityId).then((options) => {
      if (!cancelled) setLoaded({ entityId, options });
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
  const options = loaded && loaded.entityId === entityId ? loaded.options : [];
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
