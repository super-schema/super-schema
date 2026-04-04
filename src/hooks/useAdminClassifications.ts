/**
 * Admin Classifications hooks — wrappers for classification taxonomy oRPC calls.
 */

import { useState, useCallback } from "react";
import type { ClassificationLevel, CreateClassificationInput, UpdateClassificationInput } from "@/types/schemas/classification-taxonomy";

export function useAdminClassifications() {
  const [levels, setLevels] = useState<ClassificationLevel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLevels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // In production: call oRPC admin.classifications.getAll
      setLevels([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch classifications");
    } finally {
      setLoading(false);
    }
  }, []);

  const createLevel = useCallback(async (input: CreateClassificationInput) => {
    try {
      // In production: call oRPC admin.classifications.create
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create classification");
    }
  }, []);

  const updateLevel = useCallback(async (input: UpdateClassificationInput) => {
    try {
      // In production: call oRPC admin.classifications.update
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update classification");
    }
  }, []);

  const deleteLevel = useCallback(async (id: string) => {
    try {
      // In production: call oRPC admin.classifications.delete
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete classification");
    }
  }, []);

  return { levels, loading, error, fetchLevels, createLevel, updateLevel, deleteLevel };
}
