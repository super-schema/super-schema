"use client";

// src/features/events/event-page/use-event-versions.ts
// The Versions tab's two reads: the list of the event's published versions, and the stored code of one of them. Both are plain
// "latest answer for these arguments" hooks: the answer is stored together with what it was for, so an answer that arrives after the
// arguments changed (or after the tab was left) is never shown.
import { useCallback, useEffect, useState } from "react";
import { listEventVersionsAction, readEventVersionAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import type { EventVersionSummary } from "@/lib/events/types";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

export interface EventVersionsState {
  /** Newest first; null until the first answer. While a reload runs it is the previous answer. */
  versions: EventVersionSummary[] | null;
  /** The reason the last call failed; null when it succeeded or is still running. */
  error: string | null;
  reload: () => void;
}

interface ListSettled {
  key: string;
  versions: EventVersionSummary[] | null;
  error: string | null;
}

/**
 * Lists the event's versions when the component using it mounts (the tab opens) and again when `latestLabel` changes (a publish from
 * the page header) or `reload()` is called. A failed call is an `error`, never an empty list.
 */
export function useEventVersions(args: { eventId: string; productId: string; latestLabel: string | null }): EventVersionsState {
  const { eventId, productId, latestLabel } = args;
  const [reloads, setReloads] = useState(0);
  const [settled, setSettled] = useState<ListSettled | null>(null);
  const key = `${eventId}\u0000${productId}\u0000${latestLabel ?? ""}\u0000${reloads}`;
  const answer = settled?.key === key ? settled : null;
  const current = answer !== null;

  useEffect(() => {
    if (current) return;
    let cancelled = false;
    void (async () => {
      let next: Pick<ListSettled, "versions" | "error">;
      try {
        const result = await listEventVersionsAction(eventId, productId);
        next = result.success
          // The service answers newest first; sorting here keeps the tab right whatever order a future answer comes in.
          ? { versions: [...result.data].sort((a, b) => b.sequence - a.sequence), error: null }
          : { versions: null, error: actionErrorText(result) };
      } catch {
        // A rejected server action (network drop, serialization error, unwrapped server throw): never print the cause.
        next = { versions: null, error: GENERIC_ACTION_ERROR };
      }
      if (!cancelled) setSettled({ key, ...next });
    })();
    return () => {
      cancelled = true;
    };
  }, [current, key, eventId, productId]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { versions: settled?.versions ?? null, error: answer?.error ?? null, reload };
}

export type VersionCodeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; yaml: string; json: string }
  | { status: "error"; message: string };

interface CodeSettled {
  eventId: string;
  productId: string;
  label: string;
  reloads: number;
  outcome: { yaml: string; json: string } | { message: string };
}

/** The stored code of version `label` (null = none selected: idle). Selecting another label replaces the answer; `retry()` asks again. */
export function useEventVersionCode(args: { eventId: string; productId: string; label: string | null }): VersionCodeState & { retry: () => void } {
  const { eventId, productId, label } = args;
  const [reloads, setReloads] = useState(0);
  const [settled, setSettled] = useState<CodeSettled | null>(null);
  const answer = label !== null && settled?.eventId === eventId && settled.productId === productId && settled.label === label && settled.reloads === reloads ? settled : null;
  const current = answer !== null;

  useEffect(() => {
    if (label === null || current) return;
    let cancelled = false;
    void (async () => {
      let outcome: CodeSettled["outcome"];
      try {
        const result = await readEventVersionAction(eventId, productId, label);
        outcome = result.success ? { yaml: result.data.yaml, json: result.data.json } : { message: actionErrorText(result) };
      } catch {
        outcome = { message: GENERIC_ACTION_ERROR };
      }
      if (!cancelled) setSettled({ eventId, productId, label, reloads, outcome });
    })();
    return () => {
      cancelled = true;
    };
  }, [current, eventId, productId, label, reloads]);

  const retry = useCallback(() => setReloads((n) => n + 1), []);
  let state: VersionCodeState;
  if (label === null) state = { status: "idle" };
  else if (answer === null) state = { status: "loading" };
  else state = "message" in answer.outcome ? { status: "error", message: answer.outcome.message } : { status: "ready", ...answer.outcome };
  return { ...state, retry };
}
