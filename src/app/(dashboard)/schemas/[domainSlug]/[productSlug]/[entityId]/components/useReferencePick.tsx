"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { setFieldReferenceAction } from "../actions";
import { ReferencePickDialog } from "@/components/custom/ReferencePickDialog/ReferencePickDialog";
import type { PublishNeedsReference } from "@/lib/entity-versioning/publish-plan";
import type { EntityRef } from "@/lib/references/entity-reference";

/**
 * The pick an ambiguous bare-name reference asks for: the field and the name it refers to, the entities that name matches, and the
 * entity + field that HOLD the reference (a member of the closure as often as the entity on screen). `generateSchemaAction`,
 * `publishSchemaAction` and `publishEntityAction` all answer this one shape as `needsReference`.
 */
export type ReferencePickRequest = PublishNeedsReference;

/** At most this many different picks are asked within one operation; the bound only guards a server that never settles. */
const MAX_PICKS = 10;

/** The sentence for an ambiguity that could not be resolved by asking (the pick was saved but the server still finds it ambiguous). */
export function unresolvedReferenceMessage(request: Pick<ReferencePickRequest, "field" | "name" | "candidates">, then = "generate"): string {
  return `Field "${request.field}" refers to "${request.name}", which matches ${request.candidates.length} entities. Choose the entity it means on that field, then ${then} again.`;
}

/**
 * The pick a result asks for, if it asks for one: its `needsReference`. Checked BEFORE the result's generic `error` is looked at (a
 * publish answers `{ error, code, needsReference }`, a generation `{ needsReference }` only), and tolerant of a result of any other shape.
 */
export function pickRequestOf(result: unknown): ReferencePickRequest | undefined {
  if (result === null || typeof result !== "object" || !("needsReference" in result)) return undefined;
  const needs = (result as { needsReference?: unknown }).needsReference;
  if (needs === null || typeof needs !== "object") return undefined;
  const n = needs as Partial<Record<keyof ReferencePickRequest, unknown>>;
  if (
    typeof n.field !== "string" ||
    typeof n.name !== "string" ||
    !Array.isArray(n.candidates) ||
    typeof n.entityId !== "string" ||
    typeof n.fieldId !== "string"
  ) {
    return undefined;
  }
  return { field: n.field, name: n.name, candidates: n.candidates as EntityRef[], entityId: n.entityId, fieldId: n.fieldId };
}

/**
 * The one hook that asks "which entity do you mean?" and saves the answer. Render `dialog` once in the component.
 *
 * - `pickReference(request)`: opens the dialog; the choice is saved with `setFieldReferenceAction(request.entityId, request.fieldId,
 *   { entityId: picked })` (never a version: only the pin control stores one). Resolves true once saved, false when the user cancelled.
 *   A save the server refuses is shown inside the dialog, which stays open.
 * - `resolveReferences(run)`: runs an operation and, while its result asks for a pick, asks, saves it and runs the operation again (one
 *   retry per pick). Resolves to the final result, or null when the user cancelled. A result that still asks for the SAME field after
 *   its pick was saved (or past `MAX_PICKS`) is returned as is, never asked again: it still carries `needsReference` and its own `error`.
 */
export function useReferencePick() {
  const [request, setRequest] = useState<ReferencePickRequest | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settle = useRef<((saved: boolean) => void) | null>(null);

  const close = useCallback((saved: boolean) => {
    setRequest(null);
    setSaving(false);
    setError(null);
    settle.current?.(saved);
    settle.current = null;
  }, []);

  // A pending question must not outlive the component that asked it.
  useEffect(() => () => {
    settle.current?.(false);
    settle.current = null;
  }, []);

  const pickReference = useCallback(
    (asked: ReferencePickRequest) =>
      new Promise<boolean>((resolve) => {
        settle.current?.(false);
        settle.current = resolve;
        setError(null);
        setSaving(false);
        setRequest(asked);
      }),
    [],
  );

  const resolveReferences = useCallback(
    async <R,>(run: () => Promise<R>): Promise<R | null> => {
      const asked = new Set<string>();
      for (;;) {
        const result = await run();
        const needed = pickRequestOf(result);
        if (!needed) return result;
        const key = `${needed.entityId}:${needed.fieldId}`;
        if (asked.has(key) || asked.size >= MAX_PICKS) return result;
        asked.add(key);
        if (!(await pickReference(needed))) return null;
      }
    },
    [pickReference],
  );

  const handlePick = async (picked: EntityRef) => {
    if (!request) return;
    if (!picked.entityId) {
      setError("This entity has no id, so the choice cannot be saved.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await setFieldReferenceAction(request.entityId, request.fieldId, { entityId: picked.entityId });
      if (!saved.success) {
        setError(saved.error.message);
        setSaving(false);
        return;
      }
      close(true);
    } catch {
      setError("Could not save the choice. Try again.");
      setSaving(false);
    }
  };

  const dialog: ReactNode = request ? (
    <ReferencePickDialog
      candidates={request.candidates}
      field={request.field}
      name={request.name}
      error={error}
      saving={saving}
      onPick={(ref) => void handlePick(ref)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { pickReference, resolveReferences, dialog };
}
