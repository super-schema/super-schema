"use client";

import { useEffect, useState } from "react";
import { Grid3x3, Users } from "lucide-react";
import { RoleMatrix } from "@/components/custom/admin/RoleMatrix";
import { UserDataTable } from "@/components/custom/admin/UserDataTable";
import { cn } from "@/lib/utils";
import type { GrantableScopes } from "@/types/schemas/user-admin";
import { getGrantableScopesAction } from "./actions";

type View = "users" | "matrix";

const VIEWS: Array<{ id: View; label: string; icon: typeof Users }> = [
  { id: "users", label: "Users", icon: Users },
  { id: "matrix", label: "Role matrix", icon: Grid3x3 },
];

/**
 * Admin Panel — Users tab (default): the people of the tenant with their status and roles, invitations, and the role matrix. The places a role may be
 * granted in (what the scope pickers offer) are read once here and shared by both views.
 */
export default function AdminUsersPage() {
  const [view, setView] = useState<View>("users");
  const [scopes, setScopes] = useState<GrantableScopes | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getGrantableScopesAction().then((res) => {
      if (cancelled) return;
      if ("data" in res && res.data) setScopes(res.data);
      else setScopesError("error" in res && res.error ? res.error : "The places you may grant roles in could not be loaded.");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-space-4">
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div>
          <h2 className="text-heading-3 text-foreground">Users</h2>
          <p className="text-body-small text-muted-foreground">Invite people, manage their accounts and assign role-based access control by tenant, domain and product.</p>
        </div>
        <div role="group" aria-label="View" className="flex gap-space-1 rounded-lg bg-muted p-1">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              data-testid={`admin-view-${id}`}
              onClick={() => setView(id)}
              className={cn(
                "flex items-center gap-space-2 rounded-md px-space-3 py-1 text-body-small transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary",
                view === id ? "bg-background text-foreground font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
      {scopesError && (
        <p role="alert" data-testid="admin-scopes-error" className="text-caption text-destructive">{scopesError}</p>
      )}
      {view === "users" ? <UserDataTable scopes={scopes} scopesError={scopesError} /> : <RoleMatrix scopes={scopes} />}
    </div>
  );
}
