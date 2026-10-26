"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X, Save, KeyRound } from "lucide-react";
import { RolesEditor } from "./RolesEditor";
import { GuardedButton } from "./GuardedButton";
import { ResetLinkDialog } from "./ResetLinkDialog";
import { UserStatusToggle } from "./UserStatusToggle";
import { UserStatusBadge } from "./UserStatusBadge";
import type { GrantableScopes, ListedUser } from "@/types/schemas/user-admin";
import { updateUserNameAction } from "@/app/(dashboard)/admin/actions";

interface UserDetailPanelProps {
  /** An account (an invitation has no panel: it is revoked from the list). */
  user: ListedUser;
  /** What the caller may grant (null while it loads or when it could not be read). */
  scopes: GrantableScopes | null;
  onClose: () => void;
  onChanged?: () => void;
}

export const formatLastSignIn = (value: Date | string | null): string => (value ? new Date(value).toLocaleString() : "Never");

/**
 * One account: its name (editable), its status and last sign-in, what an administrator may do to the account (disable or enable, make a password reset
 * link) and its roles. A panel beside the list, not a modal: it takes focus when it opens, Escape closes it, and focus returns to where it came from.
 */
export function UserDetailPanel({ user, scopes, onClose, onChanged }: UserDetailPanelProps) {
  const [name, setName] = useState(user.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const userId = user.userId ?? user.id;

  useEffect(() => {
    // Take focus from the row that opened the panel; give it back when the panel goes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    const node = panel.current;
    // A native listener: the dialogs a panel opens are portaled out of it, and a React handler would also hear their Escape through the component tree.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    node?.addEventListener("keydown", onKeyDown);
    return () => {
      node?.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
    // Once per opening of a panel.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSaveName() {
    setSaving(true);
    setError(null);
    const res = await updateUserNameAction(userId, name);
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onChanged?.();
  }

  const account = user.status === "invited" ? "active" : user.status;
  const resetBlocked = !user.manageable ? "This account cannot be changed from here." : user.status === "disabled" ? "Enable the account before making a reset link." : null;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="user-detail-panel"
      data-email={user.email}
      className="fixed inset-y-0 right-0 w-96 max-w-full bg-background border-l border-border shadow-lg z-50 flex flex-col animate-panel-expand"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-space-4 py-space-3 border-b border-border">
        <h3 id={titleId} ref={heading} tabIndex={-1} className="text-heading-4 text-foreground outline-none">
          User Details
        </h3>
        <button
          type="button"
          onClick={onClose}
          data-testid="user-detail-close"
          aria-label="Close user details"
          className="p-1 rounded-md hover:bg-accent text-muted-foreground"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-space-4 space-y-space-6">
        {/* User info */}
        <section className="space-y-space-3" aria-label="User info">
          <h4 className="text-label text-muted-foreground uppercase tracking-wider">User Info</h4>
          <div className="space-y-space-1">
            <p className="block text-body-small text-muted-foreground">Email</p>
            <p className="text-body text-foreground break-all">{user.email}</p>
          </div>
          <div className="flex flex-wrap items-center gap-space-3">
            <UserStatusBadge status={user.status} />
            <span className="text-caption text-muted-foreground" data-testid="user-last-sign-in">
              Last sign-in: {formatLastSignIn(user.lastLoginAt)}
            </span>
          </div>
          <div className="space-y-space-1">
            <label htmlFor={`${titleId}-name`} className="block text-body-small text-muted-foreground">Name</label>
            <div className="flex items-center gap-space-2">
              <input
                id={`${titleId}-name`}
                type="text"
                data-testid="user-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 min-w-0 bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
              />
              <button
                type="button"
                onClick={handleSaveName}
                data-testid="user-name-save"
                aria-label="Save name"
                disabled={saving || name === (user.name ?? "")}
                className="p-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
            {error && (
              <p role="alert" data-testid="user-name-error" className="text-caption text-destructive">
                {error}
              </p>
            )}
          </div>
        </section>

        {/* Account */}
        <section className="space-y-space-3" aria-label="Account">
          <h4 className="text-label text-muted-foreground uppercase tracking-wider">Account</h4>
          <div className="flex flex-wrap gap-space-2">
            <UserStatusToggle user={{ userId, email: user.email, status: account, disableBlockedReason: user.disableBlockedReason }} onChanged={onChanged} />
            <GuardedButton type="button" variant="outline" size="sm" data-testid="user-reset-link" blockedReason={resetBlocked} onClick={() => setResetOpen(true)}>
              <KeyRound aria-hidden="true" />
              Reset password link
            </GuardedButton>
          </div>
          {user.disableBlockedReason && (
            <p data-testid="user-account-note" className="text-caption text-muted-foreground">
              {user.disableBlockedReason}
            </p>
          )}
        </section>

        {/* Roles */}
        <section className="space-y-space-3" aria-label="Roles">
          <h4 className="text-label text-muted-foreground uppercase tracking-wider">Roles</h4>
          <RolesEditor userId={userId} roles={user.roles} scopes={scopes} onChanged={onChanged} />
        </section>
      </div>

      <ResetLinkDialog open={resetOpen} onOpenChange={setResetOpen} user={{ userId, email: user.email }} />
    </div>
  );
}
