"use client";

import { useCallback, useRef, useState } from "react";
import {
  emitEventSpecDraftAction, getEventSpecVersionDocumentAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-spec-emit-actions";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { EventSpecEmission } from "@/services/events/event-spec-emit.service";

type EmissionState = { status: "idle" | "loading" | "ready" | "error"; emission: EventSpecEmission | null; error: string | null };

const IDLE: EmissionState = { status: "idle", emission: null, error: null };

/**
 * Draft emission (rendered + parser-validated on the server) or a version's stored document. A draft is private to its product, so
 * `productId` (the page's owning product) must own the spec; a published version is readable across the tenant. Both are scoped
 * server-side. Errors are shown through `actionErrorText`, so raw database / driver text never reaches the page; a response that
 * arrives after a newer `load()` started is dropped.
 */
export function useEventSpecEmission(specId: string, productId: string, versionLabel: string | null) {
  const [state, setState] = useState<EmissionState>(IDLE);
  const latestRun = useRef(0);
  const load = useCallback(async () => {
    const run = ++latestRun.current;
    setState((s) => ({ ...s, status: "loading", error: null }));
    let next: EmissionState;
    try {
      const r = versionLabel
        ? await getEventSpecVersionDocumentAction(specId, versionLabel)
        : await emitEventSpecDraftAction(specId, productId);
      next = r.success ? { status: "ready", emission: r.data, error: null } : { status: "error", emission: null, error: actionErrorText(r) };
    } catch {
      next = { status: "error", emission: null, error: GENERIC_ACTION_ERROR };
    }
    if (run === latestRun.current) setState(next);
  }, [specId, productId, versionLabel]);
  return { ...state, load };
}
