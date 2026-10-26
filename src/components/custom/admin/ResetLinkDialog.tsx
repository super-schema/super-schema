"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createResetLinkAction } from "@/app/(dashboard)/admin/actions";
import type { ResetLinkResult } from "@/types/schemas/user-admin";
import { CopyableLink } from "./CopyableLink";

interface ResetLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account the link is for. */
  user: { userId: string; email: string };
  /** Called once the link exists (an audit entry and an older link replaced behind it). */
  onCreated?: (result: ResetLinkResult) => void;
}

const formatWhen = (value: Date | string): string => new Date(value).toLocaleString();

/**
 * A password reset link for one person, in two steps so one is never made by a stray click: it asks first (an earlier link of this person stops working),
 * then shows the one-hour link once, copyable. There is no e-mail service: the administrator hands the link over. The service's message is shown when it
 * refuses (a disabled account, an account outside the administrator's reach).
 */
export function ResetLinkDialog({ open, onOpenChange, user, onCreated }: ResetLinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent data-testid="reset-link-dialog" className="sm:max-w-md">
        <ResetContent user={user} onClose={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function ResetContent({ user, onClose, onCreated }: { user: ResetLinkDialogProps["user"]; onClose: () => void; onCreated?: (result: ResetLinkResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetLinkResult | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await createResetLinkAction(user.userId);
    setBusy(false);
    if ("data" in answer && answer.data) {
      setResult(answer.data);
      onCreated?.(answer.data);
      return;
    }
    setError("error" in answer && answer.error ? answer.error : "Something went wrong. Please try again.");
  }

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Password reset link</DialogTitle>
          <DialogDescription>
            Send this link to <span className="font-medium text-foreground">{user.email}</span>. They open it and choose a new password.
          </DialogDescription>
        </DialogHeader>
        <CopyableLink link={result} label="Password reset link" testId="reset-link" autoFocus />
        <p data-testid="reset-link-expiry" className="text-caption text-muted-foreground">
          The link works once and expires in 1 hour ({formatWhen(result.expiresAt)}).
          {result.invalidatedLinks > 0 && ` ${result.invalidatedLinks === 1 ? "An earlier link" : `${result.invalidatedLinks} earlier links`} for this person no longer work.`}
        </p>
        <p role="note" data-testid="reset-link-warning" className="rounded-md border border-warning/30 bg-warning/5 px-space-3 py-space-2 text-caption text-foreground">
          This link is shown only once. Copy it now: it cannot be shown again, and anyone who has it can set this person&apos;s password.
        </p>
        <DialogFooter>
          <Button type="button" onClick={onClose} data-testid="reset-done">Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Make a password reset link?</DialogTitle>
        <DialogDescription>
          This makes a one-hour link for <span className="font-medium text-foreground">{user.email}</span> to choose a new password. Any earlier reset link for them stops working.
          Their current password and sessions are not changed until they use it.
        </DialogDescription>
      </DialogHeader>
      {error && (
        <p role="alert" data-testid="reset-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-3 py-space-2 text-caption text-destructive">{error}</p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="button" onClick={create} disabled={busy} data-testid="reset-create">
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          Make the link
        </Button>
      </DialogFooter>
    </>
  );
}
