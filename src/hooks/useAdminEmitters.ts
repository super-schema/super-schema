/**
 * Admin Emitters hooks — wrappers for emitter config oRPC calls.
 */

import { useState, useCallback } from "react";
import type { EmitterConfigWithStats } from "@/types/schemas/emitter-config";

export function useAdminEmitters() {
  const [emitters, setEmitters] = useState<EmitterConfigWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEmitters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // In production: call oRPC admin.emitters.getAll
      setEmitters([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch emitters");
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleEmitter = useCallback(async (name: string, enabled: boolean) => {
    try {
      // In production: call oRPC admin.emitters.updateConfig
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle emitter");
    }
  }, []);

  const testEmitter = useCallback(async (name: string, entityId: string) => {
    try {
      // In production: call oRPC admin.emitters.test
      return null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to test emitter");
      return null;
    }
  }, []);

  return { emitters, loading, error, fetchEmitters, toggleEmitter, testEmitter };
}
