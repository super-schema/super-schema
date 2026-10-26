"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { inviteUserAction } from "@/app/(dashboard)/admin/actions";
import type { Role } from "@/types/schemas/rbac";
import type { GrantableScopes, InviteUserResult } from "@/types/schemas/user-admin";
import { CopyableLink } from "./CopyableLink";
import { ScopePicker } from "./ScopePicker";
import { ASSIGNABLE_ROLES, defaultSelection, reconcileSelection, roleLabel, selectionToInput, type ScopeSelection } from "./scope-selection";

/** The most roles one invitation carries from this screen (the service allows more; a person with this many needs an administrator's attention). */
export const MAX_INVITE_ROLES = 10;

interface InviteUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the caller may grant (null while it loads or when it could not be read). */
  scopes: GrantableScopes | null;
  /** Why `scopes` could not be read, in the server's words. */
  scopesError?: string | null;
  /** Called once the invitation exists (the list behind the dialog reloads). */
  onInvited?: (result: InviteUserResult) => void;
}

type Row = { key: number; role: Role; selection: ScopeSelection };

const FIELD_CLASS = "w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary";

const formatWhen = (value: Date | string): string => new Date(value).toLocaleString();

/**
 * Invite a person by link: an e-mail address and the roles they start with, each with where it applies (the scope picker offers only places the caller may
 * grant). On success the dialog shows the one-time link with its expiry and says plainly that it is shown once. There is no e-mail service: the
 * administrator copies the link and hands it over. The service's own message is shown for every refusal.
 */
export function InviteUserDialog({ open, onOpenChange, scopes, scopesError, onInvited }: InviteUserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal>
      <DialogContent data-testid="invite-user-dialog" className="max-h-[90vh] gap-space-4 overflow-y-auto sm:max-w-lg">
        {/* Mounted only while the dialog is open, so every opening starts from an empty form. */}
        <InviteContent scopes={scopes} scopesError={scopesError} onClose={() => onOpenChange(false)} onInvited={onInvited} />
      </DialogContent>
    </Dialog>
  );
}

function InviteContent({ scopes, scopesError, onClose, onInvited }: { scopes: GrantableScopes | null; scopesError?: string | null; onClose: () => void; onInvited?: (result: InviteUserResult) => void }) {
  const nextKey = useRef(1);
  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<Row[]>(() => [{ key: 0, role: "VIEWER", selection: scopes ? defaultSelection(scopes.scopes, "VIEWER") : defaultSelection([], "VIEWER") }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteUserResult | null>(null);

  const update = (key: number, change: (row: Row) => Row) => setRows((current) => current.map((row) => (row.key === key ? change(row) : row)));

  useEffect(() => {
    // The places the caller may grant arrive after the dialog opened (they are read once by the page): a row still without a place gets the only tenant on
    // offer, as it would have had it been made later. A place the person already chose is left alone.
    if (!scopes) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows((current) => current.map((row) => (row.selection.platform || row.selection.tenantId ? row : { ...row, selection: defaultSelection(scopes.scopes, row.role) })));
  }, [scopes]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!scopes || busy) return;
    setError(null);
    if (email.trim() === "") return setError("Enter the e-mail address of the person to invite.");
    const roles = [];
    for (const row of rows) {
      const input = selectionToInput(row.selection);
      if (input === null) return setError("Choose where each role applies.");
      roles.push({ role: row.role, ...input });
    }
    setBusy(true);
    const answer = await inviteUserAction({ email, roles });
    setBusy(false);
    if ("data" in answer && answer.data) {
      setResult(answer.data);
      onInvited?.(answer.data);
      return;
    }
    setError("error" in answer && answer.error ? answer.error : "Something went wrong. Please try again.");
  }

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Invitation ready</DialogTitle>
          <DialogDescription>
            Send this link to <span className="font-medium text-foreground" data-testid="invite-result-email">{result.email}</span>. They open it, choose a name and a password, and are signed in.
          </DialogDescription>
        </DialogHeader>
        <CopyableLink link={result} label="Invitation link" testId="invite-link" autoFocus />
        <p data-testid="invite-link-expiry" className="text-caption text-muted-foreground">
          The link works once and expires {formatWhen(result.expiresAt)}.
          {result.replacedInvitations > 0 && ` It replaces ${result.replacedInvitations === 1 ? "an earlier invitation" : `${result.replacedInvitations} earlier invitations`} for this address.`}
        </p>
        <p role="note" data-testid="invite-link-warning" className="rounded-md border border-warning/30 bg-warning/5 px-space-3 py-space-2 text-caption text-foreground">
          This link is shown only once. Copy it now: it cannot be shown again, and anyone who has it can set up the account.
        </p>
        <DialogFooter>
          <Button type="button" onClick={onClose} data-testid="invite-done">Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-space-4" noValidate>
      <DialogHeader>
        <DialogTitle>Invite a user</DialogTitle>
        <DialogDescription>They get a one-time link and start with the roles you choose here. You can change their roles later.</DialogDescription>
      </DialogHeader>

      {scopesError && (
        <p role="alert" data-testid="invite-scopes-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-3 py-space-2 text-caption text-destructive">{scopesError}</p>
      )}

      <div className="space-y-space-1">
        <label htmlFor="invite-email" className="block text-caption text-muted-foreground">Email address</label>
        <input
          id="invite-email"
          data-testid="invite-email"
          type="email"
          autoComplete="off"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error !== null && email.trim() === ""}
          className={FIELD_CLASS}
        />
      </div>

      {scopes === null && !scopesError && (
        <p className="text-caption text-muted-foreground" role="status"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading the places you can invite to…</p>
      )}

      {scopes && rows.map((row, index) => (
        <div key={row.key} data-testid="invite-role-row" className="space-y-space-3 rounded-md border border-border p-space-3">
          <div className="flex items-end gap-space-2">
            <div className="min-w-0 flex-1 space-y-space-1">
              <label htmlFor={`invite-role-${row.key}`} className="block text-caption text-muted-foreground">{rows.length > 1 ? `Role ${index + 1}` : "Role"}</label>
              <select
                id={`invite-role-${row.key}`}
                data-testid="invite-role"
                className={FIELD_CLASS}
                value={row.role}
                onChange={(event) => {
                  const role = event.target.value as Role;
                  update(row.key, (current) => ({ ...current, role, selection: reconcileSelection(current.selection, scopes.scopes, scopes.canGrantPlatform, role) }));
                }}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <option key={role} value={role}>{roleLabel(role)}</option>
                ))}
              </select>
            </div>
            {rows.length > 1 && (
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove role ${index + 1}`} data-testid="invite-role-remove" onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}>
                <Trash2 aria-hidden="true" />
              </Button>
            )}
          </div>
          <ScopePicker
            scopes={scopes}
            role={row.role}
            value={row.selection}
            idPrefix={`invite-scope-${row.key}`}
            onChange={(selection) => update(row.key, (current) => ({ ...current, selection }))}
          />
        </div>
      ))}

      {scopes && rows.length < MAX_INVITE_ROLES && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="invite-add-role"
            onClick={() => setRows((current) => [...current, { key: nextKey.current++, role: "VIEWER", selection: defaultSelection(scopes.scopes, "VIEWER") }])}
          >
            <Plus aria-hidden="true" />
            Add another role
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" data-testid="invite-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-3 py-space-2 text-caption text-destructive">{error}</p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" data-testid="invite-submit" disabled={busy || scopes === null}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          Create invitation
        </Button>
      </DialogFooter>
    </form>
  );
}
