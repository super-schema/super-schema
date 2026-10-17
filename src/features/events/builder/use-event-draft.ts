"use client";

// src/features/events/builder/use-event-draft.ts
// The builder's editable copy of an event document: client-side validation by the same parser the server runs, dirty tracking,
// single-flight save through an injected action, and a leave-without-saving guard.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEventDocument } from "@/lib/events/document/parse";
import type { DocumentProblem, EventDocument } from "@/lib/events/document/types";
import type { EventDetail } from "@/services/events/event.service";
import { actionErrorText, GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";
import { readProblems } from "./problems";

export interface DraftState {
  /** The event being edited and the product it lives in: what a section needs to call the read actions (external references). */
  eventId: string;
  productId: string;
  doc: EventDocument;
  setDoc: (next: EventDocument) => void;
  update: (fn: (d: EventDocument) => EventDocument) => void;
  /** Client-side parse problems, recomputed on every change. */
  problems: DocumentProblem[];
  /** From the last failed save; cleared on the next edit. */
  serverProblems: DocumentProblem[];
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** Calls `saveDocument(event.id, productId, doc)`. True on success (dirty resets, `onSaved(detail)` runs); a failure keeps every edit. */
  save: () => Promise<boolean>;
  discard: () => void;
}

/** B4 passes `updateEventDocumentAction`; the builder never imports the actions module. */
export type SaveDocument = (eventId: string, productId: string, document: unknown) => Promise<ActionResult<EventDetail>>;

interface Core {
  eventId: string;
  doc: EventDocument;
  /** The last document the server accepted (or the one the page loaded). */
  saved: EventDocument;
  serverProblems: DocumentProblem[];
  error: string | null;
}

const initialCore = (event: EventDetail): Core => ({
  eventId: event.id, doc: event.document, saved: event.document, serverProblems: [], error: null,
});

/** JSON with sorted keys: two documents with the same content compare equal whatever order their keys were added in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  ));
}

export function useEventDraft(args: {
  event: EventDetail; productId: string; saveDocument: SaveDocument; onSaved?: (detail: EventDetail) => void;
}): DraftState {
  const { event, productId, saveDocument, onSaved } = args;
  const [stored, setCore] = useState<Core>(() => initialCore(event));
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  // Another event (same component instance, new props): start over instead of showing the previous event's edits.
  let core = stored;
  if (stored.eventId !== event.id) {
    core = initialCore(event);
    setCore(core);
  }

  /** Apply `change` to the core unless it already belongs to a different event. */
  const patch = useCallback((eventId: string, change: (c: Core) => Core) => {
    setCore((c) => (c.eventId === eventId ? change(c) : c));
  }, []);

  const update = useCallback((fn: (d: EventDocument) => EventDocument) => {
    setCore((c) => {
      const next = fn(c.doc);
      return next === c.doc ? c : { ...c, doc: next, serverProblems: [], error: null };
    });
  }, []);
  const setDoc = useCallback((next: EventDocument) => update(() => next), [update]);
  const discard = useCallback(() => {
    setCore((c) => ({ ...c, doc: c.saved, serverProblems: [], error: null }));
  }, []);

  const problems = useMemo<DocumentProblem[]>(() => {
    const parsed = parseEventDocument(core.doc);
    return parsed.success ? [] : readProblems(parsed.error.details);
  }, [core.doc]);
  const dirty = useMemo(() => canonical(core.doc) !== canonical(core.saved), [core.doc, core.saved]);

  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    const eventId = event.id;
    const sent = core.doc;
    patch(eventId, (c) => ({ ...c, serverProblems: [], error: null }));
    let detail: EventDetail | null = null;
    try {
      const result = await saveDocument(eventId, productId, sent);
      if (result.success) {
        detail = result.data;
        patch(eventId, (c) => ({ ...c, saved: sent }));
      } else {
        const text = actionErrorText(result);
        // The problems describe `sent`: if the user kept typing meanwhile they no longer point at the right fields.
        patch(eventId, (c) => ({ ...c, error: text, serverProblems: c.doc === sent ? readProblems(result.details) : [] }));
      }
    } catch {
      // A rejected server action (network drop, serialization error, unwrapped server throw): never print the cause.
      patch(eventId, (c) => ({ ...c, error: GENERIC_ACTION_ERROR }));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
    if (!detail) return false;
    try {
      onSaved?.(detail);
    } catch (e: unknown) {
      // The draft is saved; a failing follow-up (refresh, toast) must not read as a failed save.
      console.error("[event-draft] onSaved threw", e);
    }
    return true;
  }, [core.doc, event.id, onSaved, patch, productId, saveDocument]);

  // Leave-without-saving guard for tab close / reload / external navigation.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  return {
    eventId: event.id, productId, doc: core.doc, setDoc, update, problems, serverProblems: core.serverProblems,
    dirty, saving, error: core.error, save, discard,
  };
}
