"use client";

import { useState } from "react";
import { Loader2, UserCheck, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setUserDisabledAction } from "@/app/(dashboard)/admin/actions";
import { GuardedButton } from "./GuardedButton";

interface UserStatusToggleProps {
  user: {
    userId: string;
    email: string;
    /** `invited` rows have no account to disable and never get this control. */
    status: "active" | "disabled";
    /** Why disabling or enabling is unavailable right now (the server's sentence), or null. */
    disableBlockedReason: string | null;
  };
  /** Called after the change was made (the list behind it reloads). */
  onChanged?: () => void;
}

/**
 * Disable or enable an account, with a confirmation. An account is never deleted: disabling is how a person loses access, and it takes effect on their next
 * request. When the change is not available (yourself, the last platform administrator, an account out of the administrator's reach) the button stays in
 * place, disabled FOR A REASON the person can read; the server refuses it all the same. The service's own message is shown when it refuses a change that
 * the screen thought possible (a race).
 */
export function UserStatusToggle({ user, onChanged }: UserStatusToggleProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabling = user.status === "active";

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await setUserDisabledAction(user.userId, disabling);
    setBusy(false);
    if ("success" in answer && answer.success) {
      setOpen(false);
      onChanged?.();
      return;
    }
    setError("error" in answer && answer.error ? answer.error : "Something went wrong. Please try again.");
  }

  return (
    <>
      <GuardedButton
        type="button"
        variant="outline"
        size="sm"
        data-testid="user-status-toggle"
        data-action={disabling ? "disable" : "enable"}
        blockedReason={user.disableBlockedReason}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {disabling ? <UserX aria-hidden="true" /> : <UserCheck aria-hidden="true" />}
        {disabling ? "Disable account" : "Enable account"}
      </GuardedButton>

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)} modal>
        <DialogContent data-testid="user-status-dialog" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{disabling ? "Disable this account?" : "Enable this account?"}</DialogTitle>
            <DialogDescription>
              {disabling ? (
                <>
                  <span className="font-medium text-foreground">{user.email}</span> is signed out on their next request and cannot sign in until you enable the account. Their roles, their work and
                  the record of what they did stay as they are, and any password reset link they were given stops working.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">{user.email}</span> can sign in again with their current password, with the roles they held. They need a new reset link if they forgot it.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" data-testid="user-status-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-3 py-space-2 text-caption text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="button" onClick={confirm} disabled={busy} data-testid="user-status-confirm">
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {disabling ? "Disable account" : "Enable account"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
