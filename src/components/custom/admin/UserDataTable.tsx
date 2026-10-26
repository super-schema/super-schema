"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Shield, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROLE_COLORS } from "@/types/schemas/rbac";
import type { GrantableScopes, ListedRole, ListedUser, UserStatus } from "@/types/schemas/user-admin";
import { UserDetailPanel, formatLastSignIn } from "./UserDetailPanel";
import { InviteUserDialog } from "./InviteUserDialog";
import { UserStatusBadge } from "./UserStatusBadge";
import { listUsersAction, revokeInvitationAction } from "@/app/(dashboard)/admin/actions";

interface UserDataTableProps {
  /** What the caller may grant: fills the invitation dialog and the role editor. Null while it loads or when it could not be read. */
  scopes: GrantableScopes | null;
  scopesError?: string | null;
}

type StatusFilter = "all" | UserStatus;

const COLUMN_COUNT = 5;

/** The scope next to a role badge: the platform, or the names of the tenant, domain or product (no ids). */
const scopeText = (role: ListedRole): string => role.scope.label;

function RoleBadges({ roles }: { roles: ListedRole[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r, index) => {
        const colors = ROLE_COLORS[r.role];
        return (
          <span
            key={r.id ?? `${r.role}:${r.scope.scopeKey}:${index}`}
            data-testid="user-role-badge"
            data-role={r.role}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption ${colors.bg} ${colors.text}`}
          >
            <Shield className="w-3 h-3" aria-hidden="true" />
            {r.role}
            <span className="font-normal">({scopeText(r)})</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The people of the tenant (and the invitations nobody has accepted yet): e-mail, name, status (active, disabled, invited), roles with the names of their
 * scopes, last sign-in. A row opens the account's detail panel; an invitation is revoked from its own row. The toolbar filters by text and status and opens
 * the invitation dialog. What is listed is what the server says the caller reaches.
 */
export function UserDataTable({ scopes, scopesError }: UserDataTableProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ListedUser[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await listUsersAction();
    if ("data" in res && res.data) {
      setItems(res.data.items);
      setTruncated(res.data.truncated);
    } else {
      setError("error" in res && res.error ? res.error : "The users could not be loaded.");
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const selected = selectedId ? (items.find((item) => item.kind === "user" && item.id === selectedId) ?? null) : null;

  const needle = search.trim().toLowerCase();
  const filtered = items.filter(
    (u) =>
      (status === "all" || u.status === status) &&
      (needle === "" || u.email.toLowerCase().includes(needle) || (u.name?.toLowerCase().includes(needle) ?? false))
  );

  async function revoke(invitationId: string) {
    setRevoking(true);
    setError(null);
    const res = await revokeInvitationAction(invitationId);
    setRevoking(false);
    setConfirmRevoke(null);
    if ("error" in res && res.error) {
      setError(res.error);
      return;
    }
    await load();
  }

  return (
    <div className="space-y-space-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-space-3">
        <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 flex-1 min-w-48 max-w-sm">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <input
            type="text"
            data-testid="user-filter"
            aria-label="Filter users"
            placeholder="Filter by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
          />
        </div>
        <div className="flex items-center gap-space-2">
          <label htmlFor="user-status-filter" className="text-caption text-muted-foreground">Status</label>
          <select
            id="user-status-filter"
            data-testid="user-status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="invited">Invited</option>
          </select>
        </div>
        <Button type="button" size="sm" className="ml-auto" data-testid="invite-user-open" onClick={() => setInviteOpen(true)}>
          <UserPlus aria-hidden="true" />
          Invite user
        </Button>
      </div>

      {error && (
        <div role="alert" data-testid="user-table-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-space-4 py-space-3 text-body-small text-destructive">
          {error}
        </div>
      )}
      {truncated && (
        <p role="note" data-testid="user-table-truncated" className="text-caption text-muted-foreground">
          The list is cut at its limit: filter to find the person you are looking for.
        </p>
      )}

      {/* Table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-body-small" data-testid="user-table">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th scope="col" className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Email</th>
              <th scope="col" className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Name</th>
              <th scope="col" className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Status</th>
              <th scope="col" className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Roles</th>
              <th scope="col" className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-space-4 py-space-8 text-center text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-space-2" aria-hidden="true" />
                  Loading users…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-space-4 py-space-8 text-center text-muted-foreground">
                  {search.trim() || status !== "all" ? "No users match your filter." : "No users found."}
                </td>
              </tr>
            ) : (
              filtered.map((user) =>
                user.kind === "invitation" ? (
                  <tr key={`invitation-${user.id}`} data-testid="invitation-row" data-email={user.email} data-invitation-id={user.id} className="border-b border-border last:border-0">
                    <td className="px-space-4 py-space-3 text-foreground break-all">{user.email}</td>
                    <td className="px-space-4 py-space-3 text-foreground">{"—"}</td>
                    <td className="px-space-4 py-space-3"><UserStatusBadge status="invited" /></td>
                    <td className="px-space-4 py-space-3"><RoleBadges roles={user.roles} /></td>
                    <td className="px-space-4 py-space-3 text-muted-foreground">
                      <div className="flex flex-wrap items-center gap-space-2">
                        <span data-testid="invitation-expiry">Expires {user.expiresAt ? new Date(user.expiresAt).toLocaleString() : "—"}</span>
                        {confirmRevoke === user.id ? (
                          <span className="flex items-center gap-1">
                            <button
                              type="button"
                              data-testid="invitation-revoke-confirm"
                              disabled={revoking}
                              onClick={() => revoke(user.id)}
                              className="text-caption text-destructive px-2 py-0.5 rounded hover:bg-destructive/10"
                            >
                              Confirm revoke
                            </button>
                            <button type="button" onClick={() => setConfirmRevoke(null)} className="text-caption text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            data-testid="invitation-revoke"
                            aria-label={`Revoke the invitation of ${user.email}`}
                            onClick={() => setConfirmRevoke(user.id)}
                            className="text-caption text-destructive px-2 py-0.5 rounded hover:bg-destructive/10"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr
                    key={user.id}
                    data-testid="user-row"
                    data-email={user.email}
                    data-status={user.status}
                    className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
                    onClick={() => setSelectedId(user.id)}
                  >
                    <td className="px-space-4 py-space-3 text-foreground break-all">
                      <button
                        type="button"
                        data-testid="user-open"
                        aria-label={`Open ${user.email}`}
                        className="text-left underline-offset-2 hover:underline focus-visible:underline outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(user.id);
                        }}
                      >
                        {user.email}
                      </button>
                    </td>
                    <td className="px-space-4 py-space-3 text-foreground">{user.name ?? "—"}</td>
                    <td className="px-space-4 py-space-3"><UserStatusBadge status={user.status} /></td>
                    <td className="px-space-4 py-space-3"><RoleBadges roles={user.roles} /></td>
                    <td className="px-space-4 py-space-3 text-muted-foreground" data-testid="user-last-sign-in-cell">{formatLastSignIn(user.lastLoginAt)}</td>
                  </tr>
                )
              )
            )}
          </tbody>
        </table>
      </div>

      {/* User detail panel */}
      {selected && <UserDetailPanel key={selected.id} user={selected} scopes={scopes} onClose={() => setSelectedId(null)} onChanged={load} />}

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} scopes={scopes} scopesError={scopesError} onInvited={() => void load()} />
    </div>
  );
}
