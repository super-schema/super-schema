"use client";

import { useState } from "react";
import { Plus, Trash2, Shield } from "lucide-react";
import { ROLE_COLORS, ROLE_HIERARCHY, SYSTEM_ONLY_ROLES, type Role } from "@/types/schemas/rbac";

interface RolesEditorProps {
  userId: string;
  roles: { id: string; role: Role; domainId: string | null; domainName?: string }[];
}

export function RolesEditor({ userId, roles }: RolesEditorProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRole, setNewRole] = useState<Role>("VIEWER");
  const [newDomainId, setNewDomainId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isSystemRole = SYSTEM_ONLY_ROLES.includes(newRole);

  function handleAddRole() {
    setError(null);
    // In production, call oRPC mutation
    setShowAddForm(false);
    setNewRole("VIEWER");
    setNewDomainId("");
  }

  function handleRemoveRole(roleId: string) {
    setError(null);
    // In production, call oRPC mutation
    // Safety check would happen server-side
    setConfirmRemove(null);
  }

  return (
    <div className="space-y-space-3">
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
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title="Remove role"
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
        <p className="text-caption text-destructive">{error}</p>
      )}

      {/* Add role form */}
      {showAddForm ? (
        <div className="p-space-3 rounded-md border border-border space-y-space-3">
          <div className="space-y-space-2">
            <label className="block text-caption text-muted-foreground">Role</label>
            <select
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
              <label className="block text-caption text-muted-foreground">Domain</label>
              <input
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
              className="px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small"
            >
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
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md text-body-small text-primary hover:bg-primary/10 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Role
        </button>
      )}
    </div>
  );
}
