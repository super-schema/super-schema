"use client";

import { useState } from "react";
import { Plus, Trash2, Shield, Loader2 } from "lucide-react";
import { ROLE_COLORS, ROLE_HIERARCHY, SYSTEM_ONLY_ROLES, type Role } from "@/types/schemas/rbac";
import { assignRoleAction, removeRoleAction } from "@/app/(dashboard)/admin/actions";

interface RolesEditorProps {
  userId: string;
  roles: { id: string; role: Role; domainId: string | null; domainName?: string }[];
  onChanged?: () => void;
}

export function RolesEditor({ userId, roles, onChanged }: RolesEditorProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRole, setNewRole] = useState<Role>("VIEWER");
  const [newDomainId, setNewDomainId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSystemRole = SYSTEM_ONLY_ROLES.includes(newRole);

  async function handleAddRole() {
    setError(null);
    if (!isSystemRole && !newDomainId.trim()) {
      setError("A domain is required for this role.");
      return;
    }
    setBusy(true);
    const res = await assignRoleAction({
      userId,
      role: newRole,
      domainId: isSystemRole ? undefined : newDomainId.trim(),
    });
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setShowAddForm(false);
    setNewRole("VIEWER");
    setNewDomainId("");
    onChanged?.();
  }

  async function handleRemoveRole(roleId: string) {
    setError(null);
    setBusy(true);
    const res = await removeRoleAction(roleId);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      setConfirmRemove(null);
      return;
    }
    setConfirmRemove(null);
    onChanged?.();
  }

  return (
    <div className="space-y-space-3" data-testid="roles-editor">
      {/* Current roles list */}
      {roles.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No roles assigned</p>
      ) : (
        <div className="space-y-space-2">
          {roles.map((r) => {
            const colors = ROLE_COLORS[r.role];
            return (
              <div
                key={r.id}
                data-testid="role-item"
                data-role={r.role}
                data-domain-id={r.domainId ?? ""}
                className="flex items-center justify-between p-space-2 rounded-md bg-muted/50"
              >
                <div className="flex items-center gap-space-2">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption ${colors.bg} ${colors.text}`}
                  >
                    <Shield className="w-3 h-3" />
                    {r.role}
                  </span>
                  {r.domainId ? (
                    <span className="text-caption text-muted-foreground">
                      {r.domainName ?? r.domainId}
                    </span>
                  ) : (
                    <span className="text-caption bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded">
                      System
                    </span>
                  )}
                </div>

                {confirmRemove === r.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleRemoveRole(r.id)}
                      data-testid="role-remove-confirm"
                      className="text-caption text-destructive px-2 py-0.5 rounded hover:bg-destructive/10"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmRemove(null)}
                      className="text-caption text-muted-foreground px-2 py-0.5 rounded hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(r.id)}
                    data-testid="role-remove"
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title="Remove role"
                    aria-label={`Remove role ${r.role}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Error display */}
      {error && (
        <p role="alert" data-testid="role-error" className="text-caption text-destructive">
          {error}
        </p>
      )}

      {/* Add role form */}
      {showAddForm ? (
        <div data-testid="role-add-form" className="p-space-3 rounded-md border border-border space-y-space-3">
          <div className="space-y-space-2">
            <label htmlFor="role-add-select" className="block text-caption text-muted-foreground">Role</label>
            <select
              id="role-add-select"
              data-testid="role-add-select"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
            >
              {ROLE_HIERARCHY.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>

          {!isSystemRole && (
            <div className="space-y-space-2">
              <label htmlFor="role-add-domain" className="block text-caption text-muted-foreground">Domain</label>
              <input
                id="role-add-domain"
                data-testid="role-add-domain"
                type="text"
                placeholder="Domain ID"
                value={newDomainId}
                onChange={(e) => setNewDomainId(e.target.value)}
                className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
              />
            </div>
          )}

          {isSystemRole && (
            <p className="text-caption text-muted-foreground">
              This role is system-level (applies globally).
            </p>
          )}

          <div className="flex items-center gap-space-2">
            <button
              onClick={handleAddRole}
              data-testid="role-add-submit"
              disabled={busy}
              className="px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small disabled:opacity-50 inline-flex items-center gap-1"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Add Role
            </button>
            <button
              onClick={() => { setShowAddForm(false); setError(null); }}
              className="px-space-3 py-1.5 rounded-md text-body-small text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          data-testid="role-add-open"
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md text-body-small text-primary hover:bg-primary/10 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Role
        </button>
      )}
    </div>
  );
}
