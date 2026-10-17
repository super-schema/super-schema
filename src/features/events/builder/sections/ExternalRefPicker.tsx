"use client";

// src/features/events/builder/sections/ExternalRefPicker.tsx
// "Add from another event": a dialog in three steps that picks WHAT an external reference points at, so the user never types an id.
//   1. the event   — a search over the published events of the tenant (debounced; the event being edited is never offered),
//   2. the version — the referenceable versions of that event, the newest preselected,
//   3. the item    — the channels or the messages (`kind`) of that version: key, title, summary; the ones this event already
//                    references are disabled. Choosing one generates the reference's key (from its title, else its key; unique across
//                    the event's namespace); the key stays behind the collapsed Identifier, where it can be renamed.
// Add hands `{ key, eventVersionId, kind, itemKey }` to `onAdd` and closes. Steps 1 and 3 are cmdk lists (the pattern of the properties
// chooser); step 2 is a short radio list. The read actions are the ones of `event-actions` (productId FIRST), loaded on first use.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DocExternalRef, EventDocument } from "@/lib/events/document/types";
import type { ExternalEventCandidate, ExternalItemKind, ExternalItemSummary, ExternalVersionItems, ExternalVersionOption } from "@/lib/events/external-refs";
import { suggestKey } from "@/lib/events/templates/keys";
import { actionErrorText, GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";
import { takenKeys } from "../auto-key";
import { IdentifierDisclosure } from "../Identifier";
import {
  addExternalTitle, ALREADY_USED, EVENTS_LOADING, filterItemsLabel, ITEMS_LOADING, LATEST_BADGE, loadFailedText, noEventsText, noItemsText, NO_VERSIONS,
  PICKER_ADD, PICKER_BACK, PICKER_CANCEL, PICKER_NEXT, pickerStepText, publishedOnText, SEARCH_EVENTS_LABEL, SEARCH_EVENTS_PLACEHOLDER, VERSIONS_LABEL, VERSIONS_LOADING,
} from "../labels";
import { externalRefActions } from "../use-external-ref-status";

/** How long the search text must stay unchanged before the events are searched. */
export const SEARCH_DEBOUNCE_MS = 250;

type Actions = Awaited<ReturnType<typeof externalRefActions>>;
type Settled<T> = { key: string; ok: true; data: T } | { key: string; ok: false; error: string };
/** `stale` is the previous answer while a new one is on its way (the search keeps its list on screen). */
type Loaded<T> = { state: "loading"; stale?: T } | { state: "ready"; data: T } | { state: "failed"; error: string };

/**
 * Run `load` once for every distinct `key` (`null` = not now) and report where it stands. An answer for another key than the current
 * one is dropped, a failed call is a `failed` state with a safe message, and nothing is ever retried by itself.
 */
function useLoaded<T>(key: string | null, load: (actions: Actions) => Promise<ActionResult<T>>): Loaded<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void (async () => {
      let next: Settled<T>;
      try {
        const actions = await externalRefActions();
        const result = await loadRef.current(actions);
        next = result.success ? { key, ok: true, data: result.data } : { key, ok: false, error: actionErrorText(result) };
      } catch {
        // A rejected server action (network drop, serialization error, unwrapped server throw): never print the cause.
        next = { key, ok: false, error: GENERIC_ACTION_ERROR };
      }
      if (!cancelled) setSettled(next);
    })();
    return () => { cancelled = true; };
  }, [key]);

  if (key === null || settled === null || settled.key !== key) return { state: "loading", stale: settled?.ok ? settled.data : undefined };
  return settled.ok ? { state: "ready", data: settled.data } : { state: "failed", error: settled.error };
}

/** The text a reference's key is made from: the item's title when it has something a key can be made of, else its own key. */
const keySource = (item: ExternalItemSummary): string => (item.title !== undefined && /[a-zA-Z0-9]/.test(item.title) ? item.title : item.key);

export function ExternalRefPicker({ open, onOpenChange, productId, eventId, kind, doc, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  /** The event being edited: left out of the search, and never offered. */
  eventId: string;
  /** Which items the last step lists: the Channels section adds channels, the Messages section adds messages. */
  kind: ExternalItemKind;
  /** The document being edited: which items are taken already, and which keys. */
  doc: EventDocument;
  onAdd: (ref: DocExternalRef) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" initialFocus={searchRef} data-testid="external-ref-picker">
        <PickerFlow
          productId={productId} eventId={eventId} kind={kind} doc={doc} searchRef={searchRef}
          onAdd={onAdd} onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The flow itself, mounted only while the dialog is open: every opening starts at step 1 with nothing chosen. */
function PickerFlow({ productId, eventId, kind, doc, searchRef, onAdd, onClose }: {
  productId: string; eventId: string; kind: ExternalItemKind; doc: EventDocument; searchRef: RefObject<HTMLInputElement | null>;
  onAdd: (ref: DocExternalRef) => void; onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [event, setEvent] = useState<ExternalEventCandidate | null>(null);
  const [pickedVersion, setPickedVersion] = useState<string | null>(null);
  const [itemKey, setItemKey] = useState<string | null>(null);
  const [refKey, setRefKey] = useState("");
  // Choosing an event, Next and Back unmount the control that had focus. `goTo` marks that focus is owed to the new step's primary control
  // (the search, the selected version, the items' filter): the effect below pays it as soon as that control exists.
  const versionsRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const focusOwed = useRef(false);
  const goTo = (next: 1 | 2 | 3) => {
    focusOwed.current = true;
    setStep(next);
  };

  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const candidates = useLoaded<ExternalEventCandidate[]>(`q:${term}`, (a) => a.listExternalEventCandidatesAction(productId, eventId, term === "" ? undefined : term));
  const versions = useLoaded<ExternalVersionOption[]>(event ? `v:${event.eventId}` : null, (a) => a.listExternalEventVersionsAction(productId, event?.eventId ?? ""));
  // The newest version (the loader's first) until the user picks another.
  const versionList = versions.state === "ready" ? versions.data : [];
  const versionId = pickedVersion !== null && versionList.some((v) => v.versionId === pickedVersion) ? pickedVersion : (versionList[0]?.versionId ?? null);
  const items = useLoaded<ExternalVersionItems>(step === 3 && versionId ? `i:${versionId}` : null, (a) => a.getExternalVersionItemsAction(productId, versionId ?? ""));

  useEffect(() => {
    if (!focusOwed.current) return;
    const target = step === 1 ? searchRef.current : step === 3 ? filterRef.current : versionsRef.current?.querySelector<HTMLInputElement>("input:checked") ?? null;
    if (target !== null) {
      focusOwed.current = false;
      target.focus();
    } else if (step === 2 && versions.state !== "loading") {
      focusOwed.current = false; // no version to land on (failed, or none): do not grab focus later, out of the blue
    }
    // Step 2's radios only exist once the versions are listed: the run after that pays the debt.
  }, [step, versions.state, versionList.length, searchRef]);

  const taken = useMemo(() => takenKeys(doc, "externalRef"), [doc]);
  // The server leaves the event itself out; this keeps it out even if an answer ever included it.
  const events = (candidates.state === "ready" ? candidates.data : candidates.state === "loading" ? candidates.stale : undefined)?.filter((c) => c.eventId !== eventId);
  const itemList = items.state === "ready" ? (kind === "channel" ? items.data.channels : items.data.messages) : [];
  const isUsed = (key: string) => doc.externalRefs.some((r) => r.eventVersionId === versionId && r.kind === kind && r.itemKey === key);

  function chooseEvent(candidate: ExternalEventCandidate) {
    setEvent(candidate);
    setPickedVersion(null);
    setItemKey(null);
    goTo(2);
  }
  function chooseVersion(id: string) {
    setPickedVersion(id);
    setItemKey(null);
  }
  function chooseItem(item: ExternalItemSummary) {
    setItemKey(item.key);
    const text = keySource(item);
    setRefKey(suggestKey(kind, { title: text, name: text }, taken));
  }
  function add() {
    if (versionId === null || itemKey === null) return;
    onAdd({ key: refKey, eventVersionId: versionId, kind, itemKey });
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{addExternalTitle(kind)}</DialogTitle>
        <DialogDescription>{pickerStepText(step, kind)}</DialogDescription>
      </DialogHeader>

      <div className="min-h-64 space-y-space-3">
        {step === 1 && (
          <Command shouldFilter={false} label={SEARCH_EVENTS_LABEL} className="h-auto rounded-lg border border-border p-0">
            <CommandInput
              ref={searchRef} value={query} onValueChange={setQuery} data-testid="external-ref-search"
              placeholder={SEARCH_EVENTS_PLACEHOLDER} aria-label={SEARCH_EVENTS_LABEL}
            />
            <CommandList>
              {candidates.state === "failed" && (
                <p role="alert" className="px-space-3 py-space-2 text-body-small text-destructive">{loadFailedText("published events", candidates.error)}</p>
              )}
              {events === undefined && candidates.state !== "failed" && (
                <p data-testid="external-ref-events-loading" className="px-space-3 py-space-2 text-body-small text-muted-foreground">{EVENTS_LOADING}</p>
              )}
              {events !== undefined && events.length === 0 && (
                <p data-testid="external-ref-events-empty" className="px-space-3 py-space-2 text-body-small text-muted-foreground">{noEventsText(term)}</p>
              )}
              {events?.map((c) => (
                <CommandItem key={c.eventId} value={c.eventId} onSelect={() => chooseEvent(c)} data-testid={`external-ref-event-${c.eventId}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body-small font-medium text-foreground">{c.eventName}</span>
                    <span className="block truncate text-caption text-muted-foreground">{c.domainName} / {c.productName}</span>
                  </span>
                  <Badge variant="secondary">v{c.latestLabel}</Badge>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}

        {step === 2 && (
          <div className="space-y-space-2">
            <p className="text-body-small text-foreground">
              <span className="font-medium">{event?.eventName}</span>
              <span className="text-muted-foreground"> · {event?.domainName} / {event?.productName}</span>
            </p>
            {versions.state === "loading" && <p data-testid="external-ref-versions-loading" className="text-body-small text-muted-foreground">{VERSIONS_LOADING}</p>}
            {versions.state === "failed" && <p role="alert" className="text-body-small text-destructive">{loadFailedText("the versions", versions.error)}</p>}
            {versions.state === "ready" && versionList.length === 0 && (
              <p data-testid="external-ref-versions-empty" className="text-body-small text-muted-foreground">{NO_VERSIONS}</p>
            )}
            {versionList.length > 0 && (
              <div role="radiogroup" aria-label={VERSIONS_LABEL} ref={versionsRef} data-testid="external-ref-versions" className="space-y-space-1">
                {versionList.map((v, i) => (
                  <label
                    key={v.versionId} data-testid={`external-ref-version-${v.versionId}`}
                    className="flex cursor-pointer items-center gap-space-2 rounded-md border border-border px-space-3 py-space-2 text-body-small has-checked:border-primary has-checked:bg-muted/40"
                  >
                    <input
                      type="radio" name="external-ref-version" value={v.versionId} checked={versionId === v.versionId}
                      onChange={() => chooseVersion(v.versionId)} className="size-4 shrink-0 accent-primary"
                    />
                    <span className="font-medium text-foreground">v{v.label}</span>
                    {i === 0 && <Badge variant="secondary">{LATEST_BADGE}</Badge>}
                    <span className="ml-auto text-caption text-muted-foreground">{publishedOnText(v.publishedAt.slice(0, 10))}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <>
            <Command label={filterItemsLabel(kind)} className="h-auto rounded-lg border border-border p-0">
              <CommandInput ref={filterRef} data-testid="external-ref-items-filter" placeholder={`${filterItemsLabel(kind)}…`} aria-label={filterItemsLabel(kind)} />
              <CommandList>
                {items.state === "loading" && <p data-testid="external-ref-items-loading" className="px-space-3 py-space-2 text-body-small text-muted-foreground">{ITEMS_LOADING}</p>}
                {items.state === "failed" && <p role="alert" className="px-space-3 py-space-2 text-body-small text-destructive">{loadFailedText(kind === "channel" ? "the channels" : "the messages", items.error)}</p>}
                {items.state === "ready" && itemList.length === 0 && (
                  <p data-testid="external-ref-items-empty" className="px-space-3 py-space-2 text-body-small text-muted-foreground">{noItemsText(kind, items.data.label)}</p>
                )}
                {itemList.map((item) => {
                  const used = isUsed(item.key);
                  const title = item.title?.trim();
                  return (
                    <CommandItem
                      key={item.key} value={`${item.key} ${item.title ?? ""} ${item.summary ?? ""}`} disabled={used}
                      onSelect={() => chooseItem(item)} data-checked={itemKey === item.key} data-testid={`external-ref-item-${item.key}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-small font-medium text-foreground">{title || item.key}</span>
                        {title && <code className="block truncate font-mono text-caption text-muted-foreground">{item.key}</code>}
                        {item.summary && <span className="block truncate text-caption text-muted-foreground">{item.summary}</span>}
                      </span>
                      {used && <span className="text-caption text-muted-foreground">{ALREADY_USED}</span>}
                    </CommandItem>
                  );
                })}
              </CommandList>
            </Command>
            {itemKey !== null && <IdentifierDisclosure id="external-ref-key" value={refKey} taken={taken} onRename={setRefKey} />}
          </>
        )}
      </div>

      <DialogFooter>
        {step === 1 ? (
          <Button type="button" variant="outline" size="sm" onClick={onClose}>{PICKER_CANCEL}</Button>
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => goTo(step === 3 ? 2 : 1)}>{PICKER_BACK}</Button>
            {step === 2 ? (
              <Button type="button" size="sm" disabled={versionId === null} onClick={() => goTo(3)}>{PICKER_NEXT}</Button>
            ) : (
              <Button type="button" size="sm" disabled={itemKey === null} onClick={add}>{PICKER_ADD}</Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}
