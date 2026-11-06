"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiOperationIssue } from "@/lib/api-operations/validate";
import { replaceOperationDetailsAction } from "../../../actions";
import { draftToOperation, type OperationDraft } from "./api-tab-model";

export type SaveStatus =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "invalid"; count: number }
  | { state: "error"; message: string };

type SaveResult = { success: true; warnings?: string[] } | { success?: undefined; error: string; issues?: ApiOperationIssue[] };

interface Options {
  /** The latest draft of an operation (read when the debounced save fires, not when it is scheduled). */
  getDraft: (id: string) => OperationDraft | undefined;
  /** Client-side issues of a draft: a draft with any is not sent. */
  validate: (draft: OperationDraft) => ApiOperationIssue[];
  /** Server issues of the last save of `id` ([] on success). */
  onIssues: (id: string, issues: ApiOperationIssue[]) => void;
  /** Server warnings of the last successful save of `id` ([] when none): the save went through; they never block it. */
  onWarnings?: (id: string, warnings: string[]) => void;
  delay?: number;
}

/**
 * The full replace payload. A cleared operationId is sent as "" (an absent one would mean "keep the stored value"; the server
 * normalizes "" to none).
 */
export const toSavePayload = (draft: OperationDraft): Parameters<typeof replaceOperationDetailsAction>[1] => {
  const op = draftToOperation(draft);
  return { ...op, operationId: op.operationId ?? "" };
};
const toPayload = toSavePayload;

/**
 * Debounced, per-operation autosave of the API tab, plus a tracker for the tab's other writes (create / delete / reorder)
 * so one indicator covers them all.
 *
 * Side effects never run inside a React state updater (updaters run during render, where a server action / Router update is
 * illegal: "Cannot update a component while rendering a different component"): callers update their state, then call
 * `schedule(id)` from the event handler. Each operation has its own timer (a save replaces all its parameters and responses,
 * so per-keystroke saves would race); a save result older than the newest save of that operation is ignored; pending saves are
 * flushed on unmount so leaving the tab keeps the edit.
 */
export function useOperationAutosave({ getDraft, validate, onIssues, onWarnings, delay = 400 }: Options) {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(new Map<string, number>());
  const opts = useRef({ getDraft, validate, onIssues, onWarnings });
  useEffect(() => {
    opts.current = { getDraft, validate, onIssues, onWarnings };
  }, [getDraft, validate, onIssues, onWarnings]);

  const [pending, setPending] = useState(0);
  const [inFlight, setInFlight] = useState(0);
  const [outcome, setOutcome] = useState<SaveStatus>({ state: "idle" });

  const syncPending = useCallback(() => setPending(timers.current.size), []);

  /** Run one tracked write; its failure text becomes the indicator's error. */
  const track = useCallback(async <T extends SaveResult | { success?: boolean; error?: string }>(write: () => Promise<T>): Promise<T | undefined> => {
    setInFlight((n) => n + 1);
    try {
      const result = await write();
      if (result && "error" in result && result.error) setOutcome({ state: "error", message: result.error });
      else setOutcome({ state: "saved" });
      return result;
    } catch {
      setOutcome({ state: "error", message: "Save failed. Check your connection and try again." });
      return undefined;
    } finally {
      setInFlight((n) => n - 1);
    }
  }, []);

  const saveNow = useCallback(async (id: string) => {
    const { getDraft: get, validate: check, onIssues: report, onWarnings: warn } = opts.current;
    const draft = get(id);
    if (!draft) return;
    const issues = check(draft);
    if (issues.length) {
      setOutcome({ state: "invalid", count: issues.length });
      return;
    }
    const mine = (seq.current.get(id) ?? 0) + 1;
    seq.current.set(id, mine);
    const result = await track(() => replaceOperationDetailsAction(id, toPayload(draft)) as Promise<SaveResult>);
    if (seq.current.get(id) !== mine || !result) return;
    if ("error" in result && result.error) {
      report(id, result.issues ?? []);
      return;
    }
    report(id, []);
    warn?.(id, result.success ? (result.warnings ?? []) : []);
  }, [track]);

  const schedule = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      syncPending();
      void saveNow(id);
    }, delay));
    syncPending();
  }, [delay, saveNow, syncPending]);

  /** Drop a pending save (the operation was deleted). */
  const cancel = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    syncPending();
  }, [syncPending]);

  /** Save every pending operation now (before a preview, which reads stored operations). */
  const flushAll = useCallback(async () => {
    const ids = [...timers.current.keys()];
    for (const id of ids) clearTimeout(timers.current.get(id));
    timers.current.clear();
    syncPending();
    await Promise.all(ids.map((id) => saveNow(id)));
  }, [saveNow, syncPending]);

  // Flush on unmount: fire-and-forget, no state updates (the component is gone).
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      for (const [id, t] of pendingTimers) {
        clearTimeout(t);
        const draft = opts.current.getDraft(id);
        if (draft && opts.current.validate(draft).length === 0) void replaceOperationDetailsAction(id, toPayload(draft));
      }
      pendingTimers.clear();
    };
  }, []);

  const status: SaveStatus = inFlight > 0 ? { state: "saving" } : pending > 0 ? { state: "pending" } : outcome;
  return { schedule, cancel, flushAll, track, status };
}
