"use client";

// src/features/events/builder/UnsavedChangesDialog.tsx
// The question the leave guard asks (`useLeaveGuard`): the user is about to leave with unsaved changes. Save & leave saves first and leaves
// only if the save worked; a refused or failed save keeps the dialog open with the error in it, and the user on the page. Discard &
// leave drops the changes and leaves. Stay (or Escape, or a click outside) closes the question. Nothing can dismiss it while a save runs,
// so its outcome is never lost. The dialog is open exactly while `pending` is set; the guard clears it (`proceed()` / `stay()`), and the
// base Dialog returns focus to the element that had it before.
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PendingLeave } from "./use-leave-guard";

export function UnsavedChangesDialog({ pending, saving, error, onSaveAndLeave, onDiscardAndLeave, onStay }: {
  pending: PendingLeave | null;
  /** A save is running (this dialog's, or the page's own Save). */
  saving: boolean;
  /** The last failed save's message, shown while the dialog stays open. */
  error: string | null;
  /** Saves the draft; true when it was saved. `useEventDraft().save` never throws. */
  onSaveAndLeave: () => Promise<boolean>;
  onDiscardAndLeave: () => void;
  /** Closes the question (`pending.stay()`); called for Stay, Escape and a click outside. */
  onStay: () => void;
}) {
  // The harmless choice gets the first focus, as a native confirm does.
  const stayRef = useRef<HTMLButtonElement>(null);

  async function saveAndLeave() {
    if (pending === null || saving) return;
    if (await onSaveAndLeave()) pending.proceed();
  }
  function discardAndLeave() {
    if (pending === null || saving) return;
    onDiscardAndLeave();
    pending.proceed();
  }

  return (
    <Dialog
      open={pending !== null}
      disablePointerDismissal={saving}
      onOpenChange={(open) => {
        if (!open && !saving) onStay();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false} initialFocus={stayRef} data-testid="unsaved-changes-dialog">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>This event has unsaved changes. Save them before you leave, or discard them.</DialogDescription>
        </DialogHeader>

        {error && <p role="alert" data-testid="unsaved-changes-error" className="text-body-small text-destructive">{error}</p>}

        <DialogFooter>
          <Button ref={stayRef} type="button" variant="outline" size="sm" onClick={onStay} disabled={saving} data-testid="leave-stay">Stay</Button>
          <Button type="button" variant="outline" size="sm" onClick={discardAndLeave} disabled={saving} data-testid="leave-discard">Discard &amp; leave</Button>
          <Button type="button" size="sm" onClick={() => { void saveAndLeave(); }} disabled={saving} data-testid="leave-save">{saving ? "Saving…" : "Save & leave"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
