"use client";

// src/features/events/builder/use-external-ref-status.ts
// What the builder asks the server about the external references of the document being edited:
//   - `useExternalRefStatus`: has the source event published a newer version, is it a major, which referenced items did it drop
//     (`getExternalRefStatusesAction`, ONE call for every reference, asked again only when a reference's version / kind / item changes);
//   - `useExternalRefItems`: the title of each referenced item and the name of its source event (`getExternalVersionItemsAction`,
//     once per distinct version: a published version never changes).
// Both are best effort. `getExternalRefStatusesAction` fails as a whole when ANY referenced version is unknown or foreign, and a
// reference can always be shown by its key, so a failure is "unavailable": no badge, no banner, no retry until the references change.
//
// The read actions are imported when first needed, so a builder that never shows an external reference never loads the
// server-action module (and the tests of the other sections never have to mock it).
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocExternalRef } from "@/lib/events/document/types";
import type { ExternalRefInput, ExternalRefStatus, ExternalVersionItems } from "@/lib/events/external-refs";

/** The read actions of external references, loaded on first use (one import, however many callers ask at once; a failed import is tried again next time). */
let loading: Promise<typeof import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions")> | undefined;
export function externalRefActions() {
  loading ??= import("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions").catch((e: unknown) => {
    loading = undefined;
    throw e;
  });
  return loading;
}

/** One status per referenced version, by `eventVersionId`. */
export type ExternalRefStatuses = ReadonlyMap<string, ExternalRefStatus>;

/** What the status loader needs of a reference: which item of which published version. The reference's own key is never sent. */
const inputOf = (ref: DocExternalRef): ExternalRefInput => ({ eventVersionId: ref.eventVersionId, kind: ref.kind, itemKey: ref.itemKey });

/**
 * The status of every referenced version of `refs`, or `null` while it is not known: nothing loaded yet, nothing referenced, or the
 * call failed (any failure, whatever its code). The last answer stays on screen while a new one is on its way, so a badge does not
 * flicker when another reference is added; a version's status never gets stale in a way that matters (published versions are immutable).
 */
export function useExternalRefStatus(productId: string, refs: readonly DocExternalRef[]): ExternalRefStatuses | null {
  const signature = JSON.stringify(refs.map(inputOf));
  const inputs = useMemo(() => JSON.parse(signature) as ExternalRefInput[], [signature]);
  const [statuses, setStatuses] = useState<ExternalRefStatuses | null>(null);

  useEffect(() => {
    if (inputs.length === 0) return;
    let cancelled = false;
    void (async () => {
      let next: ExternalRefStatuses | null = null;
      try {
        const actions = await externalRefActions();
        const result = await actions.getExternalRefStatusesAction(productId, inputs);
        if (result.success) next = new Map(result.data.map((status) => [status.eventVersionId, status]));
      } catch {
        // unavailable: the references are still listed, just without a status
      }
      if (!cancelled) setStatuses(next);
    })();
    return () => { cancelled = true; };
  }, [productId, inputs]);

  return inputs.length === 0 ? null : statuses;
}

/**
 * The real item list of one published version, or `null` when it cannot be had (any failure, whatever its code; a rejected action
 * included). For the one place that must not guess: an Update that would REMOVE a reference first checks the latest version itself.
 */
export async function loadExternalVersionItems(productId: string, versionId: string): Promise<ExternalVersionItems | null> {
  try {
    const actions = await externalRefActions();
    const result = await actions.getExternalVersionItemsAction(productId, versionId);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** What `useExternalRefItems` knows: the items of each version that loaded, and which versions it has finished asking about (loaded or failed). */
export interface ExternalRefItems {
  items: ReadonlyMap<string, ExternalVersionItems>;
  /** Versions whose request is over. A version in neither `items` nor `settled` is still on its way: show nothing for it yet. */
  settled: ReadonlySet<string>;
}

/**
 * The items (with their titles) and the source event's name of each version in `versionIds`, by version id. A version that cannot be
 * loaded is simply absent from `items` (and present in `settled`); each version is asked for once.
 */
export function useExternalRefItems(productId: string, versionIds: readonly string[]): ExternalRefItems {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ExternalVersionItems>>(() => new Map());
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const asked = useRef(new Set<string>());
  const alive = useRef(true);
  const idsKey = [...new Set(versionIds)].join("\n");

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const todo = idsKey === "" ? [] : idsKey.split("\n").filter((id) => !asked.current.has(id));
    for (const versionId of todo) {
      asked.current.add(versionId);
      void (async () => {
        const items = await loadExternalVersionItems(productId, versionId);
        if (!alive.current) return;
        if (items) setLoaded((prev) => new Map(prev).set(versionId, items));
        setSettled((prev) => new Set(prev).add(versionId));
      })();
    }
  }, [productId, idsKey]);

  return { items: loaded, settled };
}
