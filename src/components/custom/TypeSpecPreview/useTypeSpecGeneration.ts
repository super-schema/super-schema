"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { generateTypeSpecPreviewAction } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions";

interface UseTypeSpecGenerationOptions {
  entityId: string;
  /** Debounce delay in milliseconds. Default: 800 */
  debounceMs?: number;
  /** Trigger value that changes when fields update. Increment to re-generate. */
  trigger?: number;
}

interface UseTypeSpecGenerationReturn {
  source: string;
  isGenerating: boolean;
  error: string | null;
  refresh: () => void;
}

export function useTypeSpecGeneration({
  entityId,
  debounceMs = 800,
  trigger = 0,
}: UseTypeSpecGenerationOptions): UseTypeSpecGenerationReturn {
  const [source, setSource] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef(0);

  const generate = useCallback(async () => {
    const callId = ++abortRef.current;
    setIsGenerating(true);
    setError(null);

    try {
      const result = await generateTypeSpecPreviewAction(entityId);
      // Only apply if this is still the latest call
      if (callId !== abortRef.current) return;
      if (result.error) {
        setError(result.error);
      } else {
        setSource(result.source ?? "");
      }
    } catch {
      if (callId === abortRef.current) {
        setError("Failed to generate TypeSpec preview");
      }
    } finally {
      if (callId === abortRef.current) {
        setIsGenerating(false);
      }
    }
  }, [entityId]);

  // Debounced generation on trigger change
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(generate, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [trigger, generate, debounceMs]);

  // Immediate generation on entity change
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  return { source, isGenerating, error, refresh: generate };
}
