"use client";

// src/features/events/builder/sections/ExternalRefsCard.tsx
// The external references of ONE kind, under the Channels / Messages list: channels and messages that another published event defines
// and this event uses as they were in a published version. Each row says what it points at (source event, version, the item's title),
// carries an "External" badge, shows whether its source event has moved on (`v1.0 → v2.0 available`, a major called out) and offers
//   Update  — re-point to the latest version. Refused, inline, when the latest version dropped the item and an operation uses it;
//             removed, with a note, when it dropped the item and nothing uses it;
//   Remove  — with its impact first ("Used by 2 operations"): what uses the reference is taken out of it only after a confirmation.
// The status is best effort (see `use-external-ref-status`): without it a row simply has no badge. A key listed in
// `itemsMissingInLatest` is only "possibly missing" for this reference (a channel and a message can share a key), which is why an
// update is refused only for a reference an operation actually uses.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DocExternalRef, DocumentProblem } from "@/lib/events/document/types";
import type { ExternalItemKind, ExternalRefStatus, ExternalVersionItems } from "@/lib/events/external-refs";
import {
  ADD_FROM_ANOTHER_EVENT, DETAILS_UNAVAILABLE, EXTERNAL_BADGE, externalRefsEmpty, externalRefsTitle, MAJOR_BADGE, newerVersionText, REMOVE_REFERENCE,
  removeConfirmText, updateRefusedText, updateRemovedText, updateToText, usedByText,
} from "../labels";
import { problemMessage, problemsByField } from "../problems";
import type { DraftState } from "../use-event-draft";
import { useExternalRefItems, useExternalRefStatus } from "../use-external-ref-status";
import { ExternalRefPicker } from "./ExternalRefPicker";
import { externalRefUsage, Notice, plural, withoutExternalRef } from "./graph-parts";

/** What removing `ref` does to the things that use it, in words (the second half of the confirmation question). */
function removeConsequence(ref: DocExternalRef, usage: ReturnType<typeof externalRefUsage>): string {
  if (ref.kind === "message") return `take it out of ${usage.channels.length + usage.operations.length === 1 ? "that item" : "those items"}`;
  const onIt = usage.operations.filter((o) => o.channelKey === ref.key);
  const replyingOnIt = usage.operations.filter((o) => o.channelKey !== ref.key);
  return [
    onIt.length > 0 ? `delete ${plural(onIt.length, "operation")} (${onIt.map((o) => o.key).join(", ")})` : null,
    replyingOnIt.length > 0 ? `remove the reply of ${plural(replyingOnIt.length, "operation")} (${replyingOnIt.map((o) => o.key).join(", ")})` : null,
  ].filter(Boolean).join(" and ");
}

export function ExternalRefsCard({ kind, draft, problems }: {
  kind: ExternalItemKind;
  draft: DraftState;
  /** The problems of the document (client and server), for the ones that name a reference. */
  problems: DocumentProblem[];
}) {
  const { doc, update, productId, eventId } = draft;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The row's position in the WHOLE list: that is what the document's problem pointers use.
  const rows = doc.externalRefs.map((ref, index) => ({ ref, index })).filter(({ ref }) => ref.kind === kind);
  // The status covers every reference of the document in one call; the titles are only needed for this kind's rows.
  const statuses = useExternalRefStatus(productId, doc.externalRefs);
  const details = useExternalRefItems(productId, rows.map(({ ref }) => ref.eventVersionId));

  function clearMessages() {
    setRefusal(null);
    setNote(null);
  }

  function add(ref: DocExternalRef) {
    clearMessages();
    update((d) => ({ ...d, externalRefs: [...d.externalRefs, ref] }));
  }

  function updateRef(ref: DocExternalRef) {
    const status = statuses?.get(ref.eventVersionId);
    if (!status || !status.newerAvailable) return;
    clearMessages();
    if (!status.itemsMissingInLatest.includes(ref.itemKey)) {
      update((d) => ({ ...d, externalRefs: d.externalRefs.map((r) => (r.key === ref.key ? { ...r, eventVersionId: status.latestVersionId } : r)) }));
      return;
    }
    const using = externalRefUsage(doc, ref).operations;
    if (using.length > 0) {
      setRefusal({ key: ref.key, text: updateRefusedText(ref.itemKey, status.latestLabel, using.map((o) => o.key)) });
      return;
    }
    update((d) => withoutExternalRef(d, ref.key));
    setNote(updateRemovedText(ref.itemKey, status.latestLabel));
  }

  function removeRef(ref: DocExternalRef) {
    const usage = externalRefUsage(doc, ref);
    if (usage.channels.length + usage.operations.length > 0) {
      const used = [
        usage.channels.length > 0 ? `${plural(usage.channels.length, "channel")} (${usage.channels.map((c) => c.key).join(", ")})` : null,
        usage.operations.length > 0 ? `${plural(usage.operations.length, "operation")} (${usage.operations.map((o) => o.key).join(", ")})` : null,
      ].filter(Boolean).join(" and ");
      if (!window.confirm(removeConfirmText(kind, ref.key, used, removeConsequence(ref, usage)))) return;
    }
    clearMessages();
    update((d) => withoutExternalRef(d, ref.key));
  }

  const addButton = (primary: boolean) => (
    <Button
      type="button" size={primary ? "default" : "sm"} variant={primary ? "default" : "outline"} onClick={() => setPickerOpen(true)}
      data-testid="external-ref-add" className="gap-space-2"
    >
      <Plus aria-hidden="true" className="size-4" /> {ADD_FROM_ANOTHER_EVENT}
    </Button>
  );

  return (
    <section aria-label={externalRefsTitle(kind)} data-testid={`external-refs-${kind}`} className="max-w-2xl space-y-space-3">
      {note && <Notice id="external-refs-note">{note}</Notice>}

      {rows.length === 0 ? (
        <div data-testid="external-refs-empty" className="space-y-space-3 rounded-lg border border-dashed border-border p-space-4">
          <div className="space-y-space-1">
            <h3 className="text-body font-medium text-foreground">{externalRefsTitle(kind)}</h3>
            <p className="text-body-small text-muted-foreground">{externalRefsEmpty(kind)}</p>
          </div>
          {addButton(true)}
        </div>
      ) : (
        <div className="space-y-space-3 rounded-lg border border-border p-space-4">
          <div className="flex items-center justify-between gap-space-3">
            <h3 className="text-body font-medium text-foreground">{externalRefsTitle(kind)}</h3>
            {addButton(false)}
          </div>
          <ul className="space-y-space-2">
            {rows.map(({ ref, index }) => (
              <ExternalRefRow
                key={`${index}-${ref.key}`} kind={kind} reference={ref}
                status={statuses?.get(ref.eventVersionId)} details={details.get(ref.eventVersionId)}
                usage={externalRefUsage(doc, ref)} problem={problemMessage(problemsByField(problems, `/externalRefs/${index}`))}
                refusal={refusal?.key === ref.key ? refusal.text : null}
                onUpdate={() => updateRef(ref)} onRemove={() => removeRef(ref)}
              />
            ))}
          </ul>
        </div>
      )}

      <ExternalRefPicker open={pickerOpen} onOpenChange={setPickerOpen} productId={productId} eventId={eventId} kind={kind} doc={doc} onAdd={add} />
    </section>
  );
}

function ExternalRefRow({ kind, reference, status, details, usage, problem, refusal, onUpdate, onRemove }: {
  kind: ExternalItemKind;
  reference: DocExternalRef;
  status: ExternalRefStatus | undefined;
  details: ExternalVersionItems | undefined;
  usage: ReturnType<typeof externalRefUsage>;
  problem: string | undefined;
  refusal: string | null;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const { key } = reference;
  const item = (kind === "channel" ? details?.channels : details?.messages)?.find((i) => i.key === reference.itemKey);
  const title = item?.title?.trim() || reference.itemKey;
  const eventName = details?.eventName ?? status?.eventName;
  const label = details?.label ?? status?.label;
  const newer = status?.newerAvailable === true ? status : null;
  const used = usage.channels.length + usage.operations.length > 0;

  return (
    <li data-testid={`external-ref-row-${key}`} className="space-y-space-1 rounded-md border border-border bg-background p-space-3">
      <div className="flex items-start justify-between gap-space-3">
        <div className="min-w-0 space-y-space-1">
          <p className="flex items-center gap-space-2">
            <span className="truncate text-body-small font-medium text-foreground">{title}</span>
            <Badge variant="outline" data-testid={`external-ref-badge-${key}`}>{EXTERNAL_BADGE}</Badge>
          </p>
          <p className="truncate text-caption text-muted-foreground">{eventName ? `${eventName} · v${label}` : DETAILS_UNAVAILABLE}</p>
        </div>
        <div className="flex shrink-0 items-center gap-space-2">
          {newer && (
            <Button type="button" size="sm" variant="outline" onClick={onUpdate} data-testid={`external-ref-update-${key}`}>{updateToText(newer.latestLabel)}</Button>
          )}
          <Button
            type="button" size="sm" variant="outline" onClick={onRemove} data-testid={`external-ref-remove-${key}`}
            className="gap-space-1 text-muted-foreground hover:text-destructive"
          >
            <Trash2 aria-hidden="true" className="size-3.5" /> {REMOVE_REFERENCE}
          </Button>
        </div>
      </div>
      {newer && (
        <p data-testid={`external-ref-status-${key}`} className="flex items-center gap-space-2 text-caption text-foreground">
          {newerVersionText(newer.label, newer.latestLabel)}
          {newer.newerIsMajor && <Badge variant="warning">{MAJOR_BADGE}</Badge>}
        </p>
      )}
      {used && <p data-testid={`external-ref-usage-${key}`} className="text-caption text-muted-foreground">{usedByText(usage.channels.length, usage.operations.length)}</p>}
      {problem && <p data-testid={`external-ref-problem-${key}`} className="text-body-small text-destructive">{problem}</p>}
      {refusal && <Notice id={`external-ref-refused-${key}`}>{refusal}</Notice>}
    </li>
  );
}
