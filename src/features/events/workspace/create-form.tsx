"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

/** Inline create-form pieces shared by the Events and Traits tabs. */

export const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";

export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-space-1">
      <label htmlFor={htmlFor} className="block text-caption text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function FormShell({ title, testId, error, busy, onCancel, onSubmit, children }: {
  title: string; testId: string; error: string | null; busy: boolean; onCancel: () => void; onSubmit: () => void; children: ReactNode;
}) {
  return (
    <form
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onSubmit();
      }}
      className="surface-glass space-y-space-3 rounded-xl border border-primary/20 p-space-4"
    >
      <h3 className="text-heading-3 text-foreground">{title}</h3>
      {children}
      {error && <p role="alert" className="text-body-small text-destructive">{error}</p>}
      <div className="flex justify-end gap-space-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
      </div>
    </form>
  );
}

/**
 * A create action's result: the id of the new asset, or the service's message (+ its code and one-line remedy).
 * The `code` matters: `DB_ERROR` / `INTERNAL_ERROR` messages may carry raw driver text and are never displayed.
 */
type CreateResult =
  | { success: true; data: { id: string } }
  | { success: false; error: string; code?: string; suggestedFix?: string };

/**
 * Busy / error state around one create action; `onCreated` receives the new asset's id. After a successful
 * create the form stays busy (it is about to navigate away; re-enabling Create meanwhile would let a second
 * click create a duplicate); only a failure or a thrown action makes it editable again.
 */
export function useCreateForm(onCreated: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A second submit in the same tick would still see `busy === false` in its closure.
  const inFlight = useRef(false);

  async function run(action: () => Promise<CreateResult>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    let result: CreateResult;
    try {
      result = await action();
    } catch (e: unknown) {
      console.error("[create-form] the create action threw", e);
      setError(GENERIC_ACTION_ERROR);
      setBusy(false);
      inFlight.current = false;
      return;
    }
    if (result.success) {
      onCreated(result.data.id);
      return;
    }
    setError(actionErrorText(result));
    setBusy(false);
    inFlight.current = false;
  }
  return { busy, error, run };
}
