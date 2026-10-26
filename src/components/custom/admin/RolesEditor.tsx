"use client";

import { useState } from "react";
import { Plus, Trash2, Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROLE_COLORS, type Role } from "@/types/schemas/rbac";
import type { GrantableScopes, ListedRole } from "@/types/schemas/user-admin";
import { assignRoleAction, removeRoleAction } from "@/app/(dashboard)/admin/actions";
import { GuardedButton } from "./GuardedButton";
import { ScopePicker } from "./ScopePicker";
import { ASSIGNABLE_ROLES, defaultSelection, reconcileSelection, roleLabel, selectionToInput, type ScopeSelection } from "./scope-selection";

interface RolesEditorProps {
  userId: string;
  roles: ListedRole[];
  /** What the caller may grant (null while it loads or when it could not be read: roles can still be removed, none can be added). */
  scopes: GrantableScopes | null;
  onChanged?: () => void;
}

const FIELD_CLASS = "w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary";

/**
 * The roles of one person, and assigning more: a role is granted AT a scope (the platform, a tenant, a domain or a product), chosen with the scope picker
 * from the places the caller may grant it in; the raw domain id the old editor asked for is gone. Removing asks first. A role the server would refuse to
 * remove right now (your own administrator role, the last platform administrator's) has its control disabled with the reason; the server refuses it all the
 * same, and every refusal shows the service's own message.
 */
export function RolesEditor({ userId, roles, scopes, onChanged }: RolesEditorProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRole, setNewRole] = useState<Role>("VIEWER");
  const [selection, setSelection] = useState<ScopeSelection>(() => defaultSelection(scopes?.scopes ?? [], "VIEWER"));
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openForm() {
    setError(null);
    setNewRole("VIEWER");
    setSelection(defaultSelection(scopes?.scopes ?? [], "VIEWER"));
    setShowAddForm(true);
  }

  async function handleAddRole() {
    setError(null);
    const input = selectionToInput(selection);
    if (input === null) {
      setError("Choose where the role applies.");
      return;
    }
    setBusy(true);
    const res = await assignRoleAction({ userId, role: newRole, ...input });
    setBusy(false);
    if ("error" in res && res.error) {
      setError(res.error);
      return;
    }
    setShowAddForm(false);
    onChanged?.();
  }

  async function handleRemoveRole(roleId: string) {
    setError(null);
    setBusy(true);
    const res = await removeRoleAction(roleId);
    setBusy(false);
    setConfirmRemove(null);
    if ("error" in res && res.error) {
      setError(res.error);
      return;
    }
    onChanged?.();
  }

  return (
    <div className="space-y-space-3" data-testid="roles-editor">
      {/* Current roles list */}
      {roles.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No roles assigned</p>
      ) : (
        <ul className="space-y-space-2">
          {roles.map((r, index) => {
            const colors = ROLE_COLORS[r.role];
            const removable = r.id !== null;
            return (
              <li
                key={r.id ?? `${r.role}:${r.scope.scopeKey}:${index}`}
                data-testid="role-item"
                data-role={r.role}
                data-scope-key={r.scope.scopeKey}
                data-domain-id={r.scope.domainId ?? ""}
                className="flex items-center justify-between gap-space-2 p-space-2 rounded-md bg-muted/50"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-space-2">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption ${colors.bg} ${colors.text}`}>
                    <Shield className="w-3 h-3" aria-hidden="true" />
                    {r.role}
                  </span>
                  <span className="break-words text-caption text-muted-foreground" data-testid="role-scope">
                    {r.scope.label}
                  </span>
                </div>

                {removable &&
                  (confirmRemove === r.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRemoveRole(r.id as string)}
                        data-testid="role-remove-confirm"
                        disabled={busy}
                        className="text-caption text-destructive px-2 py-0.5 rounded hover:bg-destructive/10"
                      >
                        Confirm
                      </button>
                      <button type="button" onClick={() => setConfirmRemove(null)} className="text-caption text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <GuardedButton
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="role-remove"
                      blockedReason={r.removeBlockedReason ?? null}
                      onClick={() => setConfirmRemove(r.id)}
                      aria-label={`Remove role ${roleLabel(r.role)} at ${r.scope.label}`}
                      title={`Remove role ${roleLabel(r.role)}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 aria-hidden="true" />
                    </GuardedButton>
                  ))}
              </li>
            );
          })}
        </ul>
      )}

      {/* Error display */}
      {error && (
        <p role="alert" data-testid="role-error" className="text-caption text-destructive">
          {error}
        </p>
      )}

      {/* Add role form */}
      {showAddForm && scopes ? (
        <div data-testid="role-add-form" className="p-space-3 rounded-md border border-border space-y-space-3">
          <div className="space-y-space-1">
            <label htmlFor="role-add-select" className="block text-caption text-muted-foreground">Role</label>
            <select
              id="role-add-select"
              data-testid="role-add-select"
              value={newRole}
              onChange={(event) => {
                const role = event.target.value as Role;
                setNewRole(role);
                setSelection((current) => reconcileSelection(current, scopes.scopes, scopes.canGrantPlatform, role));
              }}
              className={FIELD_CLASS}
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>

          <ScopePicker scopes={scopes} role={newRole} value={selection} onChange={setSelection} idPrefix={`role-add-${userId}`} />

          <div className="flex items-center gap-space-2">
            <Button type="button" size="sm" onClick={handleAddRole} data-testid="role-add-submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Add Role
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAddForm(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={openForm} data-testid="role-add-open" disabled={scopes === null} className="text-primary">
          <Plus aria-hidden="true" />
          Add Role
        </Button>
      )}
    </div>
  );
}
