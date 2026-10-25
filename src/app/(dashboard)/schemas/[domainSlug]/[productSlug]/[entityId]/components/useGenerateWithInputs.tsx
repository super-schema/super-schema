"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { generateSchemaAction, setEntityPrimaryKeyAction } from "../actions";
import type { MissingRequirement } from "@/lib/schema-targets/requirements";
import { PrimaryKeyDialog } from "./PrimaryKeyDialog";
import { unresolvedReferenceMessage, useReferencePick } from "./useReferencePick";

type GenerateResult = Awaited<ReturnType<typeof generateSchemaAction>>;

/**
 * `generate(target)` is `generateSchemaAction` that ASKS when it needs an answer: a primary key the target needs (the dialog opens, the
 * answer is saved on the entity with `setEntityPrimaryKeyAction` and generation is retried) and which entity a bare-name reference
 * means when several match (`needsReference`: the pick dialog opens, the pick is saved on the field that holds the reference and
 * generation is retried). It resolves to the final action result, or null when the user cancelled. Render `dialog` once in the component.
 *
 * `resolveReferences(run)` is the same reference question for any other operation that can answer `needsReference` (publishing a
 * schema version): it runs `run`, asks, saves the pick and runs it again, and resolves to the final result or null on cancel.
 */
export function useGenerateWithInputs(entityId: string) {
  const [asking, setAsking] = useState<MissingRequirement | null>(null);
  const settle = useRef<((saved: boolean) => void) | null>(null);
  const { resolveReferences, dialog: referenceDialog } = useReferencePick();

  const ask = useCallback(
    (requirement: MissingRequirement) =>
      new Promise<boolean>((resolve) => {
        // A question that is still open is replaced by this one (there is one dialog): it ends as declined, so the `generate()` that asked it
        // resolves (null) instead of waiting forever for an answer that can no longer come.
        settle.current?.(false);
        settle.current = resolve;
        setAsking(requirement);
      }),
    [],
  );

  const close = useCallback((saved: boolean) => {
    setAsking(null);
    settle.current?.(saved);
    settle.current = null;
  }, []);

  const generate = useCallback(
    async (target: string): Promise<GenerateResult | null> => {
      // Each round answers one question; a target asks for at most a couple, the bound only guards a server that never settles.
      for (let round = 0; round < 3; round += 1) {
        // An ambiguous reference is asked (and saved, and generation retried) before anything else is looked at, the error included.
        const result = await resolveReferences(() => generateSchemaAction(entityId, target));
        if (!result) return null; // the user declined to choose
        if ("needsReference" in result && result.needsReference) return { error: unresolvedReferenceMessage(result.needsReference) };
        const needed = "needsInput" in result ? result.needsInput : undefined;
        if (!needed || needed.length === 0) return result;
        const requirement = needed[0];
        if (requirement.code !== "primary-key") return { error: requirement.message };
        if (!(await ask(requirement))) return null;
      }
      return { error: "Generation still needs input" };
    },
    [entityId, ask, resolveReferences],
  );

  const dialog: ReactNode = (
    <>
      {asking ? (
        <PrimaryKeyDialog
          requirement={asking}
          onCancel={() => close(false)}
          onConfirm={async (fieldNames) => {
            const saved = await setEntityPrimaryKeyAction(entityId, fieldNames);
            if ("error" in saved && saved.error) return saved.error;
            close(true);
          }}
        />
      ) : null}
      {referenceDialog}
    </>
  );

  return { generate, resolveReferences, dialog };
}
