"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Inline create-form pieces shared by the Events and Traits tabs. */

export const selectClass = "w-full rounded-md border border-border bg-background px-space-2 py-1.5 text-body-small";

/** Mirrors GENERIC_ACTION_ERROR (server-only module): shown when a server action itself throws. */
const GENERIC_ERROR = "Something went wrong. Try again; if it keeps happening, contact an administrator.";

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

/** A create action's result: the id of the new asset, or the service's message (+ its one-line remedy). */
type CreateResult = { success: true; data: { id: string } } | { success: false; error: string; suggestedFix?: string };

/** Busy / error state around one create action; `onCreated` receives the new asset's id. */
export function useCreateForm(onCreated: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<CreateResult>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.success) onCreated(result.data.id);
      else setError(result.suggestedFix ? `${result.error} ${result.suggestedFix}` : result.error);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
