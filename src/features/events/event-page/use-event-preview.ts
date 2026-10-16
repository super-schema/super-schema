"use client";

// src/features/events/event-page/use-event-preview.ts
// The Preview tab's emission of the CURRENT, possibly unsaved document: debounced, one call per document, the newest answer wins.
import { useCallback, useEffect, useRef, useState } from "react";
import { previewEventDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import type { EventDocument } from "@/lib/events/document/types";
import type { EventEmission } from "@/services/events/event-emit.service";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

/** How long the document must stay unchanged before it is sent for emission. */
export const PREVIEW_DEBOUNCE_MS = 600;

/** What the last finished call was for, and what it said. Compared with the current arguments to know whether it is still current. */
interface Settled {
  eventId: string;
  productId: string;
  doc: EventDocument;
  /** `refresh()` count at the time of the call: a refresh makes every earlier answer stale. */
  refreshes: number;
  output: EventEmission | null;
  error: string | null;
}

export interface EventPreviewState {
  /** The last successful emission (of this event). While `loading` it may be one of an earlier document. Null after a failed call. */
  output: EventEmission | null;
  /** True while `enabled` and the current document has no answer yet (debouncing or in flight). */
  loading: boolean;
  error: string | null;
  /** Re-emit now (no debounce), even for an unchanged document: entity versions may have changed on the server. */
  refresh: () => void;
}

/**
 * Emits `doc` through `previewEventDocumentAction` once it has been stable for `PREVIEW_DEBOUNCE_MS`, only while `enabled`.
 * A document that already has an answer is not sent again (reopening the tab is free); `refresh()` forces a new call. An answer
 * that arrives after the document changed, the hook was disabled or a newer call started is dropped. Errors are shown through
 * `actionErrorText`, so raw database / driver text never reaches the page. The caller decides what `enabled` means (the page:
 * the Preview tab is open and the document parses).
 */
export function useEventPreview(args: { eventId: string; productId: string; doc: EventDocument; enabled: boolean }): EventPreviewState {
  const { eventId, productId, doc, enabled } = args;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const immediate = useRef(false);

  const current = settled !== null && settled.eventId === eventId && settled.productId === productId && settled.doc === doc && settled.refreshes === refreshes;

  useEffect(() => {
    if (!enabled || current) return;
    let cancelled = false;
    async function run() {
      let next: Pick<Settled, "output" | "error">;
      try {
        const result = await previewEventDocumentAction(eventId, productId, doc);
        next = result.success ? { output: result.data, error: null } : { output: null, error: actionErrorText(result) };
      } catch {
        // A rejected server action (network drop, serialization error, unwrapped server throw): never print the cause.
        next = { output: null, error: GENERIC_ACTION_ERROR };
      }
      if (!cancelled) setSettled({ eventId, productId, doc, refreshes, ...next });
    }
    if (immediate.current) {
      immediate.current = false;
      void run();
      return () => { cancelled = true; };
    }
    const timer = setTimeout(() => { void run(); }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, current, eventId, productId, doc, refreshes]);

  const refresh = useCallback(() => {
    immediate.current = true;
    setRefreshes((n) => n + 1);
  }, []);

  return {
    output: settled !== null && settled.eventId === eventId ? settled.output : null,
    loading: enabled && !current,
    error: current ? settled.error : null,
    refresh,
  };
}
