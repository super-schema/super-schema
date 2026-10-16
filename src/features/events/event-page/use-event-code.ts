"use client";

// src/features/events/event-page/use-event-code.ts
// The code of the CURRENT, possibly unsaved draft for the Code panel: an instant build in the browser (placeholder schemas) that
// follows every edit synchronously, and the server's full render (real payload schemas) swapped in once it arrives for the same document.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewEventDocumentAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import type { Diagnostic, JsonObject } from "@/lib/event-specs/types";
import { buildInstantAsyncApi, type InstantAsyncApi, type InstantLibraryTrait } from "@/lib/events/document/instant-asyncapi";
import type { EventDocument } from "@/lib/events/document/types";
import type { EventEmission } from "@/services/events/event-emit.service";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

/** How long the document must stay unchanged before it is sent for the full render. */
export const CODE_DEBOUNCE_MS = 800;

/**
 * - `draft`: the code is the instant build (placeholder schemas) and nothing is pending (the draft is invalid, or the server could not build it).
 * - `rendering`: the instant build is shown; the full render of this document is debouncing or in flight.
 * - `full`: the server's render of exactly this document is shown (real payload schemas).
 * - `error`: the full render failed; the instant build is shown and `error` says why.
 */
export type CodeStatus = "draft" | "rendering" | "full" | "error";

export interface UseEventCodeArgs {
  eventId: string;
  productId: string;
  productSlug: string;
  doc: EventDocument;
  /** The draft does not parse: there is nothing to render, and nothing is sent to the server. */
  blocked: boolean;
  entityLabels: ReadonlyMap<string, string>;
  versionLabels?: ReadonlyMap<string, string>;
  /** libraryTraitId → the trait's stored definition (`instantLibraryTraits`): the instant build emits it instead of a stub. */
  libraryTraits?: ReadonlyMap<string, InstantLibraryTrait>;
}

export interface EventCodeState {
  /** The instant build of `doc`, always current. */
  instant: InstantAsyncApi;
  /** What to show: the server's when `status` is `full`, else the instant build's. */
  document: JsonObject | null;
  yaml: string;
  json: string;
  /** The server's diagnostics once it answered for this document, else the instant build's. */
  diagnostics: Diagnostic[];
  status: CodeStatus;
  /** Why the full render failed (`status` is `error`); never raw database or driver text. */
  error: string | null;
  /** Ask the server again now (no debounce), even for an unchanged document. */
  retry: () => void;
}

/** What the last finished call was for and what it said; compared with the current arguments to know whether it still applies. */
interface Settled {
  eventId: string;
  productId: string;
  /** `contentKey` of the document that was sent. */
  key: string;
  /** `retry()` count at the time of the call: a retry makes every earlier answer stale. */
  refreshes: number;
  output: EventEmission | null;
  error: string | null;
}

/** JSON with sorted keys: two documents with the same content are the same document whatever order their keys were added in. */
function contentKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  ));
}

/**
 * The instant build is recomputed on every document change (it is cheap and synchronous). The server is asked for the full render
 * once the document has been stable for `CODE_DEBOUNCE_MS`, never while the draft is `blocked`. An answer is applied only when it
 * is for the document on screen (same event, same content, same retry round): an answer that arrives after the document changed,
 * the draft became invalid, or the hook unmounted is dropped. Errors are shown through `actionErrorText`; the instant build stays.
 */
export function useEventCode(args: UseEventCodeArgs): EventCodeState {
  const { eventId, productId, productSlug, doc, blocked, entityLabels, versionLabels, libraryTraits } = args;
  const [settled, setSettled] = useState<Settled | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const immediate = useRef(false);

  const instant = useMemo(
    () => buildInstantAsyncApi(doc, { productSlug, entityLabels, versionLabels, libraryTraits }),
    [doc, productSlug, entityLabels, versionLabels, libraryTraits]
  );
  const key = useMemo(() => contentKey(doc), [doc]);

  const answered = settled !== null && settled.eventId === eventId && settled.productId === productId && settled.key === key && settled.refreshes === refreshes;
  const current = !blocked && answered ? settled : null;

  useEffect(() => {
    if (blocked || current !== null) return;
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
      if (!cancelled) setSettled({ eventId, productId, key, refreshes, ...next });
    }
    if (immediate.current) {
      immediate.current = false;
      void run();
      return () => { cancelled = true; };
    }
    const timer = setTimeout(() => { void run(); }, CODE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [blocked, current, eventId, productId, doc, key, refreshes]);

  const retry = useCallback(() => {
    immediate.current = true;
    setRefreshes((n) => n + 1);
  }, []);

  const output = current?.output ?? null;
  const full = output !== null && output.document !== null && output.yaml !== null && output.json !== null ? output : null;

  let status: CodeStatus;
  if (blocked) status = "draft";
  else if (current === null) status = "rendering";
  else if (current.error !== null) status = "error";
  else status = full !== null ? "full" : "draft";

  return {
    instant,
    document: full !== null ? full.document : instant.document,
    yaml: full !== null ? (full.yaml as string) : instant.yaml,
    json: full !== null ? (full.json as string) : instant.json,
    diagnostics: output !== null ? output.diagnostics : instant.diagnostics,
    status,
    error: current?.error ?? null,
    retry,
  };
}
