"use client";

import { useState } from "react";
import { X, Save } from "lucide-react";
import { RolesEditor } from "./RolesEditor";
import type { Role } from "@/types/schemas/rbac";
import { updateUserNameAction } from "@/app/(dashboard)/admin/actions";

interface UserDetailPanelProps {
  user: {
    id: string;
    email: string;
    name: string | null;
    roles: { id: string; role: Role; domainId: string | null; domainName?: string }[];
  };
  onClose: () => void;
  onChanged?: () => void;
}

export function UserDetailPanel({ user, onClose, onChanged }: UserDetailPanelProps) {
  const [name, setName] = useState(user.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveName() {
    setSaving(true);
    setError(null);
    const res = await updateUserNameAction(user.id, name);
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onChanged?.();
  }

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-background border-l border-border shadow-lg z-50 flex flex-col animate-panel-expand">
      {/* Header */}
      <div className="flex items-center justify-between px-space-4 py-space-3 border-b border-border">
        <h3 className="text-heading-4 text-foreground">User Details</h3>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-accent text-muted-foreground"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-space-4 space-y-space-6">
        {/* User info */}
        <section className="space-y-space-3">
          <h4 className="text-label text-muted-foreground uppercase tracking-wider">
            User Info
          </h4>
          <div className="space-y-space-2">
            <label className="block text-body-small text-muted-foreground">
              Email
            </label>
            <p className="text-body text-foreground">{user.email}</p>
          </div>
          <div className="space-y-space-2">
            <label className="block text-body-small text-muted-foreground">
              Name
            </label>
            <div className="flex items-center gap-space-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1 bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={handleSaveName}
                disabled={saving || name === (user.name ?? "")}
                className="p-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
              </button>
            </div>
            {error && <p className="text-caption text-destructive">{error}</p>}
          </div>
        </section>

        {/* Roles */}
        <section className="space-y-space-3">
          <h4 className="text-label text-muted-foreground uppercase tracking-wider">
            Roles
          </h4>
          <RolesEditor
            userId={user.id}
            roles={user.roles}
            onChanged={onChanged}
          />
        </section>
      </div>
    </div>
  );
}
