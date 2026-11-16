"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listPinnableVersionsAction } from "../pin-actions";
import type { EntityPin } from "@/lib/events/types";
import type { PayloadFormat } from "@/lib/event-specs/types";

import { NativeSelect } from "@/components/ui/native-select";
export interface EntityOption {
  id: string;
  name: string;
  ownerLabel: string;
  /** Where the entity lives (null at tenant / domain level); the picker's scope filter uses them. */
  domainId?: string | null;
  productId?: string | null;
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
  id, label, entities, value, onChange, optional = false, hint, loadVersions = defaultLoadVersions, disabled, autoFocus, scope,
}: {
  /** The event's product and domain: the list starts on that product and can widen to the domain or the whole tenant. */
  scope?: PickerScope;
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

  const entity = entities.find((e) => e.id === entityId) ?? null;
  const current = loaded && loaded.entityId === entityId ? loaded : null;
  const options = current && "options" in current ? current.options : [];
  const loadError = current && "error" in current ? current.error : null;
  const pinned = value?.entityVersionId ?? null;
  const pinnedLabel = options.find((option) => option.id === pinned)?.label
    ?? (pinned === entity?.latestVersionId ? entity.latestVersionLabel : null);
  const missingPinnedLabel = pinnedLabel
    ? `v${pinnedLabel} (pinned)`
    : current ? "Version number unavailable (pinned)" : "Loading version number… (pinned)";
  const behind = pinned !== null && entity?.latestVersionId && pinned !== entity.latestVersionId;

  return (
    <fieldset className="min-w-0 space-y-space-1" data-testid={`${id}-picker`}>
      <legend className="text-caption text-muted-foreground">{label}</legend>
      <div className="flex min-w-0 flex-wrap gap-space-2">
        <EntityCombobox
          id={id} label={label} entities={entities} selectedId={entityId} optional={optional} disabled={disabled} autoFocus={autoFocus} scope={scope}
          onSelect={(next) => onChange(next ? { entityId: next.id, entityVersionId: next.latestVersionId } : null)}
        />
        {entityId && (
          <NativeSelect
            aria-label={`${label} version`}
            className="min-w-0 max-w-full flex-1 basis-40"
            value={pinned ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ entityId, entityVersionId: e.target.value || null })}
          >
            <option value="">Draft (unpinned; preview only)</option>
            {pinned && !options.some((o) => o.id === pinned) && <option value={pinned} disabled={!pinnedLabel}>{missingPinnedLabel}</option>}
            {options.map((v) => (
              <option key={v.id} value={v.id}>v{v.label}{v.id === pinned ? " (pinned)" : ""}</option>
            ))}
          </NativeSelect>
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

export interface PickerScope { domainId: string; productId: string }
type ScopeLevel = "product" | "domain" | "tenant";
const SCOPE_LABELS: Record<ScopeLevel, string> = { product: "This product", domain: "This domain", tenant: "All" };
/** How many options are rendered at once; more load as the list scrolls (or with "Show more"). */
export const PAGE_SIZE = 100;

const inScope = (e: EntityOption, level: ScopeLevel, scope?: PickerScope) =>
  !scope || level === "tenant" ? true : level === "domain" ? e.domainId === scope.domainId : e.productId === scope.productId;
const matches = (e: EntityOption, q: string) => !q || e.name.toLowerCase().includes(q) || e.ownerLabel.toLowerCase().includes(q);

/** The narrowest scope that shows the selected entity (the product when nothing is selected and it has entities). */
function initialLevel(entities: EntityOption[], selected: EntityOption | null, scope?: PickerScope): ScopeLevel {
  if (!scope) return "tenant";
  const levels: ScopeLevel[] = ["product", "domain", "tenant"];
  if (selected) return levels.find((l) => inScope(selected, l, scope)) ?? "tenant";
  return levels.find((l) => entities.some((e) => inScope(e, l, scope))) ?? "tenant";
}

/**
 * Searchable entity list: starts on the event's product, widens to its domain or the whole tenant, filters as you type and renders
 * PAGE_SIZE options at a time (the next page loads when the end of the list scrolls into view).
 */
function EntityCombobox({ id, label, entities, selectedId, optional, disabled, autoFocus, scope, onSelect }: {
  id: string; label: string; entities: EntityOption[]; selectedId: string | null; optional: boolean; disabled?: boolean; autoFocus?: boolean;
  scope?: PickerScope; onSelect: (entity: EntityOption | null) => void;
}) {
  const selected = entities.find((e) => e.id === selectedId) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<ScopeLevel>(() => initialLevel(entities, selected, scope));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const listId = `${id}-entity-list`;
  const q = query.trim().toLowerCase();

  const counts = useMemo(() => {
    const c: Record<ScopeLevel, number> = { product: 0, domain: 0, tenant: 0 };
    for (const e of entities) if (matches(e, q)) for (const l of ["product", "domain", "tenant"] as const) if (inScope(e, l, scope)) c[l]++;
    return c;
  }, [entities, q, scope]);
  const results = useMemo(() => entities.filter((e) => inScope(e, level, scope) && matches(e, q)), [entities, level, scope, q]);
  const shown = results.slice(0, limit);
  const choices: (EntityOption | null)[] = optional && !q ? [null, ...shown] : shown;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => {
    const el = sentinel.current;
    if (!open || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) setLimit((n) => n + PAGE_SIZE); });
    io.observe(el);
    return () => io.disconnect();
  }, [open, shown.length, results.length]);

  function show(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) { setQuery(""); setLimit(PAGE_SIZE); setActive(0); requestAnimationFrame(() => search.current?.focus()); }
  }
  function pick(e: EntityOption | null) { onSelect(e); setOpen(false); }
  function changeLevel(next: ScopeLevel) { setLevel(next); setLimit(PAGE_SIZE); setActive(0); }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, choices.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (choices[active] !== undefined) pick(choices[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }
  const wider = scope && level !== "tenant" && q && results.length === 0 ? (["domain", "tenant"] as const).find((l) => l !== level && counts[l] > 0 && (level === "product" || l === "tenant")) : undefined;

  return (
    <div ref={root} className="relative min-w-0 max-w-full flex-1 basis-56">
      <button
        type="button" role="combobox" aria-label={`${label} entity`} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox"
        data-testid={`${id}-entity`} data-value={selectedId ?? ""} disabled={disabled} autoFocus={autoFocus} onClick={() => show(!open)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); show(true); } }}
        className={cn(selectClass, "flex w-full items-center justify-between gap-space-2 text-left disabled:opacity-50")}
      >
        <span className="min-w-0 truncate">
          {selected ? <>{selected.name} <span className="text-muted-foreground">· {selected.ownerLabel}</span></> : <span className="text-muted-foreground">{optional ? "— none —" : "Select an entity"}</span>}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 flex w-[min(32rem,90vw)] flex-col gap-space-2 rounded-md border border-border bg-popover p-space-2 shadow-md" data-testid={`${id}-entity-panel`}>
          <div className="flex items-center gap-space-2 rounded-md border border-border px-space-2">
            <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <input
              ref={search} role="searchbox" aria-label={`Search ${label.toLowerCase()} entities`} aria-controls={listId}
              aria-activedescendant={choices[active] !== undefined ? `${id}-opt-${active}` : undefined}
              value={query} placeholder="Search by name or owner" onKeyDown={onKey}
              onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); setActive(0); }}
              className="h-8 w-full bg-transparent text-body-small outline-none"
            />
          </div>
          {scope && (
            <div role="radiogroup" aria-label="Show entities from" className="flex flex-wrap gap-1">
              {(["product", "domain", "tenant"] as const).map((l) => (
                <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => changeLevel(l)}
                  className={cn("rounded-md px-space-2 py-0.5 text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring/50", level === l ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50")}>
                  {SCOPE_LABELS[l]} <span className="tabular-nums text-muted-foreground">{counts[l]}</span>
                </button>
              ))}
            </div>
          )}
          <ul id={listId} role="listbox" aria-label={`${label} entities`} className="max-h-72 overflow-y-auto">
            {choices.map((e, i) => (
              <li
                key={e?.id ?? "__none"} id={`${id}-opt-${i}`} role="option" data-entity-id={e?.id ?? ""} aria-selected={(e?.id ?? null) === selectedId}
                onMouseEnter={() => setActive(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}
                className={cn("flex cursor-pointer items-center justify-between gap-space-2 rounded px-space-2 py-1.5 text-body-small", i === active && "bg-accent")}
              >
                <span className="min-w-0">
                  <span className="block truncate">{e ? e.name : "— none —"}</span>
                  {e && <span className="block truncate text-caption text-muted-foreground">{e.ownerLabel}</span>}
                </span>
                {(e?.id ?? null) === selectedId && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
              </li>
            ))}
            {shown.length < results.length && (
              <li ref={sentinel} className="px-space-2 py-1">
                <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => setLimit((n) => n + PAGE_SIZE)}>Show more</Button>
              </li>
            )}
          </ul>
          {results.length === 0 && (
            <p className="px-space-2 text-caption text-muted-foreground">
              {q ? `No entities match “${query.trim()}”${scope && level !== "tenant" ? ` in ${SCOPE_LABELS[level].toLowerCase()}` : ""}.` : "No entities here."}
              {wider && <> <Button type="button" variant="link" size="xs" className="h-auto p-0 align-baseline" onClick={() => changeLevel(wider)}>{counts[wider]} in {SCOPE_LABELS[wider].toLowerCase()}</Button></>}
            </p>
          )}
          {results.length > 0 && <p className="px-space-2 text-caption text-muted-foreground" data-testid={`${id}-entity-count`}>Showing {Math.min(shown.length, results.length)} of {results.length}</p>}
        </div>
      )}
    </div>
  );
}
