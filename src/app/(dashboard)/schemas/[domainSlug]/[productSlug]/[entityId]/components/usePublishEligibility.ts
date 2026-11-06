"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublishBlocker } from "@/lib/entity-versioning/publish-plan";
import { getPublishPreviewAction } from "../version-actions";

/** Check the saved draft without opening the publish or reference-picking dialogs. */
export function usePublishEligibility(entityId: string, revision: object, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ entityId, revision, enabled, attempt }), [entityId, revision, enabled, attempt]);
  const [result, setResult] = useState<{
    request: typeof request;
    blockers: PublishBlocker[];
    error: string | null;
  } | null>(null);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!request.enabled) return;
    let cancelled = false;
    async function check() {
      try {
        const response = await getPublishPreviewAction(request.entityId);
        if (cancelled) return;
        setResult("error" in response
          ? { request, blockers: [], error: response.error }
          : { request, blockers: response.preview.blockers, error: null });
      } catch {
        if (!cancelled) setResult({ request, blockers: [], error: "Could not check whether this entity can be published." });
      }
    }
    void check();
    return () => { cancelled = true; };
  }, [request]);

  const current = result?.request === request ? result : null;
  return {
    checking: enabled && current === null,
    blockers: current?.blockers ?? [],
    error: current?.error ?? null,
    retry,
  };
}
