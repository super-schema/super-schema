"use client";

// src/features/events/event-page/EventPage.tsx
// The self-contained Event page: header (name, badges, rename, delete) and the Design | Docs tabs. The builder stays mounted
// while Docs shows, so an unsaved edit survives a trip to the other tab; ?tab= / ?section= / ?item= follow the state.
// The AsyncAPI code of the unsaved draft lives in the shell's right Detail Panel (see the "Code panel" block below).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, FileCode2, Loader2, PanelRightClose, PanelRightOpen, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteEventAction, renameEventAction, updateEventDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";
import { assetHref, EVENT_TABS, type BuilderSection, type EventTab } from "@/lib/navigation/asset-href";
import { instantLibraryTraits } from "@/lib/events/document/instant-asyncapi";
import { EventBuilder } from "@/features/events/builder/EventBuilder";
import { useEventDraft } from "@/features/events/builder/use-event-draft";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";
import { ConnectedEventCodePanel } from "./EventCodePanel";
import { createEventCodeSourceStore, EventCodeSourceProvider, type EventCodeSource } from "./event-code-source";
import { EventPreview } from "./EventPreview";
import type { EventPageData } from "./load-event-page";
import { useEventPreview } from "./use-event-preview";

const TAB_LABELS: Record<EventTab, string> = { design: "Design", docs: "Docs" };
const tabDomId = (tab: EventTab) => `event-tab-${tab}`;
const panelDomId = (tab: EventTab) => `event-panel-${tab}`;

/** "asyncapi@3.0" → "AsyncAPI 3.0"; a spec type this slice has no label for is shown as stored. */
function specLabel(specType: string): string {
  const match = /^asyncapi@(.+)$/.exec(specType);
  return match ? `AsyncAPI ${match[1]}` : specType;
}

/** Keyed by event: client navigation to another event reuses this component, and the tab / draft state of the previous one must not carry over. */
export function EventPage({ data }: { data: EventPageData }) {
  return <EventPageBody key={data.event.id} data={data} />;
}

function EventPageBody({ data }: { data: EventPageData }) {
  const { event, productId, domainSlug, productSlug, entityOptions, libraryTraits, crumbs, listHref } = data;
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();

  const [tab, setTab] = useState<EventTab>(data.initialTab);
  const [section, setSection] = useState<BuilderSection>(data.initialSection);
  const [item, setItem] = useState<string | null>(data.initialItem);

  const onSaved = useCallback(() => {
    toast.success("Draft saved");
    router.refresh();
  }, [router]);
  const draft = useEventDraft({ event, productId, saveDocument: updateEventDocumentAction, onSaved });
  const builderOptions = useMemo(() => ({ entityOptions, libraryTraits }), [entityOptions, libraryTraits]);

  // The Docs tab renders the document in the sandboxed iframe; it is emitted only while that tab is open.
  const docsEnabled = tab === "docs" && draft.problems.length === 0;
  const docs = useEventPreview({ eventId: event.id, productId, doc: draft.doc, enabled: docsEnabled });

  // ----- Code panel -----
  // The live code of the UNSAVED draft is the shell's right Detail Panel. The shell renders that panel above this page in the tree, so
  // the page pushes the panel element into the shell once (setContent, cleared on unmount) and feeds it the draft through a small
  // store; the panel re-renders alone on every edit. A collapsed panel is not mounted by the shell, so it costs nothing then.
  const { setContent, togglePanel, isPanelCollapsed } = useRightPanelContent();
  const entityLabels = useMemo(() => new Map(entityOptions.map((e) => [e.id, e.name] as const)), [entityOptions]);
  const versionLabels = useMemo(
    () => new Map(entityOptions.flatMap((e) => (e.latestVersionId && e.latestVersionLabel ? [[e.latestVersionId, e.latestVersionLabel] as const] : []))),
    [entityOptions]
  );
  // The instant code emits each library / built-in trait from its stored definition (the real CloudEvents properties), not a stub.
  const instantLibrary = useMemo(() => instantLibraryTraits(libraryTraits), [libraryTraits]);
  const codeSource = useMemo<EventCodeSource>(
    () => ({ eventId: event.id, productId, productSlug, doc: draft.doc, problems: draft.problems, entityLabels, versionLabels, libraryTraits: instantLibrary }),
    [event.id, productId, productSlug, draft.doc, draft.problems, entityLabels, versionLabels, instantLibrary]
  );
  const [codeStore] = useState(() => createEventCodeSourceStore(codeSource));
  useEffect(() => { codeStore.set(codeSource); }, [codeStore, codeSource]);
  useEffect(() => {
    setContent(
      <EventCodeSourceProvider store={codeStore}>
        <ConnectedEventCodePanel />
      </EventCodeSourceProvider>
    );
    return () => setContent(null);
  }, [setContent, codeStore]);

  // The URL follows the state. History API, not `router.replace`: Next syncs `useSearchParams` with it and no server render is
  // needed to switch a client tab or section. Defaults are omitted by `assetHref`, so an old `?tab=editor` is rewritten clean.
  useEffect(() => {
    const href = assetHref({ kind: "event", id: event.id, domainSlug, productSlug }, { tab, section, item: item ?? undefined });
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.replaceState(null, "", href);
  }, [tab, section, item, event.id, domainSlug, productSlug]);

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, id: EventTab) {
    const at = EVENT_TABS.indexOf(id);
    let next: number;
    if (e.key === "ArrowRight") next = (at + 1) % EVENT_TABS.length;
    else if (e.key === "ArrowLeft") next = (at - 1 + EVENT_TABS.length) % EVENT_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = EVENT_TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(EVENT_TABS[next]);
    document.getElementById(tabDomId(EVENT_TABS[next]))?.focus();
  }

  // ----- rename -----
  // The name last confirmed by the server for THIS stored name: after `router.refresh()` the prop catches up and this stops mattering.
  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null);
  const name = renamed !== null && renamed.from === event.name ? renamed.to : event.name;
  const [editing, setEditing] = useState(false);
  const [nameText, setNameText] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInFlight = useRef(false);

  function startRename() {
    setNameText(name);
    setRenameError(null);
    setEditing(true);
  }
  function cancelRename() {
    setEditing(false);
    setRenameError(null);
  }
  async function submitRename() {
    if (renameInFlight.current) return;
    const next = nameText.trim();
    if (next === "") {
      setRenameError("A name is required.");
      return;
    }
    if (next === name) return cancelRename();
    renameInFlight.current = true;
    setRenaming(true);
    setRenameError(null);
    try {
      const result = await renameEventAction(event.id, productId, next);
      if (!result.success) {
        setRenameError(actionErrorText(result));
        return;
      }
      setRenamed({ from: event.name, to: result.data.name });
      setEditing(false);
      toast.success("Event renamed");
      router.refresh();
    } catch {
      // A rejected server action (network drop, serialization error, unwrapped server throw): never print the cause.
      setRenameError(GENERIC_ACTION_ERROR);
    } finally {
      renameInFlight.current = false;
      setRenaming(false);
    }
  }
  function onNameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submitRename();
    } else if (e.key === "Escape") {
      cancelRename();
    }
  }

  // ----- delete -----
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteInFlight = useRef(false);

  async function remove() {
    if (deleteInFlight.current) return;
    if (!window.confirm(`Delete event "${name}"? Its draft is removed with it.`)) return;
    deleteInFlight.current = true;
    setDeleting(true);
    setDeleteError(null);
    let deleted = false;
    try {
      const result = await deleteEventAction(event.id, productId);
      if (!result.success) {
        setDeleteError(actionErrorText(result));
        return;
      }
      deleted = true;
      void invalidateDomainsTree(); // the explorer reads a cached tree: without this the deleted row stays until a reload
      router.push(listHref);
    } catch {
      setDeleteError(GENERIC_ACTION_ERROR);
    } finally {
      deleteInFlight.current = false;
      // After a successful delete the page is on its way out: the button stays disabled until it is gone.
      if (!deleted) setDeleting(false);
    }
  }

  return (
    <div data-testid="event-page" className="animate-auth-fade-up space-y-space-6">
      <EventBreadcrumb crumbs={crumbs} />

      <div className="flex flex-wrap items-start justify-between gap-space-3">
        <div className="min-w-0 space-y-space-2">
          <div className="flex flex-wrap items-center gap-space-2">
            <FileCode2 className="size-6 shrink-0" aria-hidden="true" />
            {editing ? (
              <div className="flex items-center gap-space-1">
                <Input
                  id="event-name-input" data-testid="event-name-input" aria-label="Event name" value={nameText} autoComplete="off" spellCheck={false}
                  autoFocus disabled={renaming} className="w-64"
                  aria-invalid={renameError ? true : undefined} aria-describedby={renameError ? "event-rename-error" : undefined}
                  onChange={(e) => setNameText(e.target.value)} onKeyDown={onNameKeyDown}
                />
                <Button type="button" size="icon-sm" onClick={() => { void submitRename(); }} disabled={renaming} aria-label="Save name" data-testid="event-rename-save">
                  {renaming ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" onClick={cancelRename} disabled={renaming} aria-label="Cancel rename" data-testid="event-rename-cancel">
                  <X className="size-4" />
                </Button>
              </div>
            ) : (
              <>
                <h1 className="text-display text-foreground">{name}</h1>
                <Button type="button" size="icon-sm" variant="ghost" onClick={startRename} aria-label="Rename event" data-testid="event-rename">
                  <Pencil className="size-4" />
                </Button>
              </>
            )}
            <Badge variant="secondary" data-testid="event-spec-badge">{specLabel(event.specType)}</Badge>
            <Badge variant="secondary" data-testid="event-version-badge">{event.latestVersionLabel ? `v${event.latestVersionLabel}` : "Unpublished"}</Badge>
            {event.hasUnpublishedChanges && <Badge variant="outline" data-testid="event-draft-badge">Draft</Badge>}
          </div>
          {renameError && (
            <p id="event-rename-error" data-testid="event-rename-error" role="alert" className="text-body-small text-destructive">{renameError}</p>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          <Button
            type="button" variant="outline" onClick={togglePanel} data-testid="event-code-toggle" className="gap-1.5"
            aria-pressed={!isPanelCollapsed} title={isPanelCollapsed ? "Show the live code panel" : "Hide the live code panel"}
          >
            {isPanelCollapsed ? <PanelRightOpen className="size-4" aria-hidden="true" /> : <PanelRightClose className="size-4" aria-hidden="true" />} Code
          </Button>
          <Button
            type="button" variant="outline" onClick={() => { void remove(); }} disabled={deleting} data-testid="event-delete"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete
          </Button>
        </div>
      </div>
      {deleteError && (
        <p data-testid="event-delete-error" role="alert" className="text-body-small text-destructive">{deleteError}</p>
      )}

      <div role="tablist" aria-label={`${name} sections`} className="flex items-center gap-space-1 border-b border-border">
        {EVENT_TABS.map((id) => (
          <button
            key={id} id={tabDomId(id)} type="button" role="tab" data-testid={tabDomId(id)}
            aria-selected={tab === id} aria-controls={panelDomId(id)} tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)} onKeyDown={(e) => onTabKeyDown(e, id)}
            className={`-mb-px border-b-2 px-space-4 py-space-2 text-body-small transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${tab === id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </div>

      {/* Both panels exist so every tab's aria-controls resolves. Design is never unmounted (unsaved edits live in its draft); Docs' content is. */}
      <div role="tabpanel" id={panelDomId("design")} aria-labelledby={tabDomId("design")} data-testid="event-panel-design" hidden={tab !== "design"}>
        <EventBuilder draft={draft} options={builderOptions} section={section} onSectionChange={setSection} item={item} onItemChange={setItem} />
      </div>
      <div role="tabpanel" id={panelDomId("docs")} aria-labelledby={tabDomId("docs")} data-testid="event-panel-docs" hidden={tab !== "docs"}>
        {tab === "docs" && (
          <div className="space-y-space-3">
            {draft.dirty && (
              <p data-testid="preview-unsaved-note" className="text-body-small text-muted-foreground">
                These docs show your unsaved changes. Go back to Design to save them.
              </p>
            )}
            <EventPreview title={name} state={docs} blocked={draft.problems.length > 0} onBackToDesign={() => setTab("design")} />
          </div>
        )}
      </div>
    </div>
  );
}
