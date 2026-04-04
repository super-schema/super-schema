/**
 * useOverrideDialog — logic hook for the type mapping override dialog.
 */

import { useState, useCallback, useMemo } from "react";
import { VALID_TARGET_TYPES } from "@/lib/type-mapping/types";
import type { OverrideDialogMappingContext } from "./TypeMappingOverrideDialog.types";

type OverrideMode = "accept" | "global" | "per-entity" | null;

export function useOverrideDialog(
  mappingContext: OverrideDialogMappingContext | null,
  userRole: string
) {
  const [mode, setMode] = useState<OverrideMode>(null);
  const [newMappedType, setNewMappedType] = useState("");
  const [justification, setJustification] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");

  // RBAC checks
  const canCreateGlobal = userRole === "STEWARD" || userRole === "ADMIN";
  const canCreateEntity =
    userRole === "AUTHOR" || userRole === "STEWARD" || userRole === "ADMIN";
  const canAcknowledge = canCreateEntity;

  // Valid target types for autocomplete
  const validTypes = useMemo(() => {
    if (!mappingContext) return [];
    return VALID_TARGET_TYPES[mappingContext.targetFormat] ?? [];
  }, [mappingContext]);

  // Filtered types for autocomplete
  const filteredTypes = useMemo(() => {
    if (!typeFilter) return validTypes;
    const lower = typeFilter.toLowerCase();
    return validTypes.filter((t) => t.toLowerCase().includes(lower));
  }, [validTypes, typeFilter]);

  // Validation
  const isValid = useMemo(() => {
    if (mode === "accept") return true;
    if (!newMappedType.trim()) return false;
    if (!justification.trim()) return false;
    return true;
  }, [mode, newMappedType, justification]);

  const reset = useCallback(() => {
    setMode(null);
    setNewMappedType("");
    setJustification("");
    setIsSubmitting(false);
    setTypeFilter("");
  }, []);

  return {
    mode,
    setMode,
    newMappedType,
    setNewMappedType,
    justification,
    setJustification,
    isSubmitting,
    setIsSubmitting,
    typeFilter,
    setTypeFilter,
    canCreateGlobal,
    canCreateEntity,
    canAcknowledge,
    validTypes,
    filteredTypes,
    isValid,
    reset,
  };
}
