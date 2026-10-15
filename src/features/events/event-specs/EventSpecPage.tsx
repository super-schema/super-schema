"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import {
  getEventSpecPublishPreviewAction, publishEventSpecAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-version-actions";
import { assetHref } from "@/lib/navigation/asset-href";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { EventVersionList } from "@/features/events/shared/EventVersionList";
import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";
import { AsyncApiPreview } from "./AsyncApiPreview";
import { DiagnosticsList } from "./DiagnosticsList";
import { DocumentView, EmissionError } from "./DocumentView";
import { EventSpecEditor } from "./EventSpecEditor";
import type { EventSpecPageData } from "./load-event-spec-page";
import { SPEC_TABS, type SpecTab } from "./spec-tabs";
import { useEventSpecEmission } from "./use-event-spec-emission";

export { normalizeSpecTab } from "./spec-tabs";

const NEEDS_EMISSION: ReadonlySet<SpecTab> = new Set(["document", "preview", "diagnostics"]);
const tabDomId = (id: SpecTab) => `spec-tab-${id}`;
const PANEL_DOM_ID = "spec-tabpanel";

/**
 * Keyed by spec and version: client navigation between `?version=` values (or back to the draft) reuses this component, and the
 * emission / tab state of the previous version must not be shown for the next one.
 */
export function EventSpecPage(props: EventSpecPageData) {
  return <EventSpecPageBody key={`${props.spec.id}:${props.viewingVersion ?? "draft"}`} {...props} />;
}

function EventSpecPageBody({
  spec, productId, domainSlug, productSlug, crumbs, channelOptions, messageOptions, operationTraits, versions, viewingVersion, initialTab, owner,
}: EventSpecPageData) {
  const router = useRouter();
  const [tab, setTab] = useState<SpecTab>(initialTab);
  const emission = useEventSpecEmission(spec.id, productId, viewingVersion);
  const { status, load } = emission;
  const requested = useRef(false);
  const specRef = { kind: "eventSpec" as const, id: spec.id, domainSlug, productSlug };
  const draftHref = assetHref(specRef);
  const readOnly = viewingVersion !== null;

  // The draft is rendered and parser-validated only when a tab needs it, and once (a ref, because dev StrictMode runs effects twice).
  useEffect(() => {
    if (NEEDS_EMISSION.has(tab) && status === "idle" && !requested.current) {
      requested.current = true;
      void load();
    }
  }, [tab, status, load]);

  function selectTab(next: SpecTab) {
    setTab(next);
    window.history.replaceState(null, "", assetHref(specRef, { version: viewingVersion ?? undefined, query: { tab: next } }));
  }

  const selectable = SPEC_TABS.filter((t) => !(t.id === "editor" && readOnly));
  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: SpecTab) {
    const at = selectable.findIndex((t) => t.id === id);
    let next: number;
    if (event.key === "ArrowRight") next = (at + 1) % selectable.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + selectable.length) % selectable.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = selectable.length - 1;
    else return;
    event.preventDefault();
    selectTab(selectable[next].id);
    document.getElementById(tabDomId(selectable[next].id))?.focus();
  }

  // A save changes the draft: refresh the server data, and re-emit only if an emission was already shown (keeps the Diagnostics count honest).
  function onSaved() {
    if (requested.current) void load();
    router.refresh();
  }

  const diagnostics = emission.emission?.diagnostics ?? [];
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const waiting = status === "idle" || status === "loading";

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <HideEmptyRightPanel />
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div className="flex flex-wrap items-center gap-space-2">
          <FileCode2 className="w-6 h-6" />
          <h1 className="text-display text-foreground">{spec.name}</h1>
          <Badge variant="secondary">{spec.specType}</Badge>
          <Badge variant="secondary">{spec.latestVersionLabel ? `latest v${spec.latestVersionLabel}` : "unpublished"}</Badge>
          {spec.latestVersionLabel && spec.hasUnpublishedChanges && <Badge variant="outline">unpublished changes</Badge>}
          {viewingVersion && <Badge>viewing v{viewingVersion}</Badge>}
        </div>
        {viewingVersion ? (
          owner ? (
            <p className="text-body-small text-muted-foreground" data-testid="spec-owner">
              Owned by {owner.label} (read-only here) — <Link href={owner.href} className="text-primary hover:underline">open in its own product</Link>
            </p>
          ) : (
            <Link href={draftHref} className="text-body-small text-primary hover:underline">Back to draft</Link>
          )
        ) : (
          <PublishVersionButton
            subjectName={spec.name}
            description="Publishing renders every payload from its pinned entity version, validates the AsyncAPI document and stores it immutably (MAJOR.MINOR becomes info.version)."
            loadPreview={() => getEventSpecPublishPreviewAction(spec.id, productId)}
            publish={(input) => publishEventSpecAction(spec.id, productId, input)}
            testId="spec-publish"
          />
        )}
      </div>

      <div role="tablist" aria-label={`${spec.name} sections`} className="flex items-center gap-space-1 border-b border-border">
        {SPEC_TABS.map((t) => (
          <button
            key={t.id}
            id={tabDomId(t.id)}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={PANEL_DOM_ID}
            tabIndex={tab === t.id ? 0 : -1}
            disabled={t.id === "editor" && readOnly}
            onClick={() => selectTab(t.id)}
            onKeyDown={(e) => onTabKeyDown(e, t.id)}
            className={`-mb-px border-b-2 px-space-4 py-space-2 text-body-small transition-colors disabled:opacity-40 ${tab === t.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            {t.id === "diagnostics" && errorCount > 0 && <span className="ml-1 text-destructive">{` (${errorCount})`}</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={PANEL_DOM_ID} aria-labelledby={tabDomId(tab)}>
        {/* Stays mounted behind the other tabs: switching to Document / Preview must not throw away unsaved edits. */}
        {!readOnly && (
          <div hidden={tab !== "editor"}>
            <EventSpecEditor
              spec={spec}
              productId={productId}
              channelOptions={channelOptions}
              messageOptions={messageOptions}
              operationTraits={operationTraits}
              onSaved={onSaved}
              onRenamed={() => router.refresh()}
            />
          </div>
        )}
        {tab === "document" && (
          <DocumentView emission={emission.emission} loading={waiting} error={emission.error} onRetry={() => void load()} />
        )}
        {tab === "preview" && (
          emission.error ? <EmissionError message={emission.error} onRetry={() => void load()} />
            : waiting ? <p className="text-body-small text-muted-foreground">Rendering…</p>
            : <AsyncApiPreview document={emission.emission?.document ?? null} title={spec.name} />
        )}
        {tab === "versions" && (
          <EventVersionList versions={versions} hrefFor={(label) => assetHref(specRef, { version: label })} emptyText="Not published yet. Publish to cut version 1.0." />
        )}
        {tab === "diagnostics" && (
          emission.error ? <EmissionError message={emission.error} onRetry={() => void load()} />
            : waiting ? <p className="text-body-small text-muted-foreground">Validating…</p>
            : <DiagnosticsList diagnostics={diagnostics} unpublishedMessages={emission.emission?.unpublishedMessages ?? []} />
        )}
      </div>
    </div>
  );
}
