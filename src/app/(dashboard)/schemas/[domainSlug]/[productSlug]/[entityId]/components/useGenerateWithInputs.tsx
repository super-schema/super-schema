"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { generateSchemaAction, setEntityPrimaryKeyAction } from "../actions";
import type { MissingRequirement } from "@/lib/schema-targets/requirements";
import { PrimaryKeyDialog } from "./PrimaryKeyDialog";

type GenerateResult = Awaited<ReturnType<typeof generateSchemaAction>>;

/**
 * `generate(target)` is `generateSchemaAction` that ASKS when the target needs an input (a primary key): the dialog opens, the
 * answer is saved on the entity (`setEntityPrimaryKeyAction`) and generation is retried. It resolves to the final action result,
 * or null when the user cancelled. Render `dialog` once in the component.
 */
export function useGenerateWithInputs(entityId: string) {
  const [asking, setAsking] = useState<MissingRequirement | null>(null);
  const settle = useRef<((saved: boolean) => void) | null>(null);

  const ask = useCallback(
    (requirement: MissingRequirement) =>
      new Promise<boolean>((resolve) => {
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
        const result = await generateSchemaAction(entityId, target);
        const needed = "needsInput" in result ? result.needsInput : undefined;
        if (!needed || needed.length === 0) return result;
        const requirement = needed[0];
        if (requirement.code !== "primary-key") return { error: requirement.message };
        if (!(await ask(requirement))) return null;
      }
      return { error: "Generation still needs input" };
    },
    [entityId, ask],
  );

  const dialog: ReactNode = asking ? (
    <PrimaryKeyDialog
      requirement={asking}
      onCancel={() => close(false)}
      onConfirm={async (fieldNames) => {
        const saved = await setEntityPrimaryKeyAction(entityId, fieldNames);
        if ("error" in saved && saved.error) return saved.error;
        close(true);
      }}
    />
  ) : null;

  return { generate, dialog };
}
