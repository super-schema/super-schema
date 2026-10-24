"use client";

import { useCallback, useEffect, useState } from "react";
import { Search, Shield, Loader2 } from "lucide-react";
import { ROLE_COLORS, type Role } from "@/types/schemas/rbac";
import { UserDetailPanel } from "./UserDetailPanel";
import { getUsersAction } from "@/app/(dashboard)/admin/actions";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  roles: { id: string; role: Role; domainId: string | null; domainName?: string }[];
  lastLogin?: string;
  status: string;
}

export function UserDataTable() {
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getUsersAction();
    if (res.error) {
      setError(res.error);
      setUsers([]);
    } else if (res.data) {
      setUsers(
        res.data.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          roles: u.roles ?? [],
          status: "active",
        }))
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Keep the open detail panel in sync after a refetch.
  useEffect(() => {
    if (!selectedUser) return;
    const fresh = users.find((u) => u.id === selectedUser.id);
    // Re-sync the open detail panel to the freshly loaded record.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fresh && fresh !== selectedUser) setSelectedUser(fresh);
  }, [users]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = users.filter(
    (u) =>
      !search.trim() ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.name?.toLowerCase().includes(search.toLowerCase()) ?? false)
  );

  return (
    <div className="space-y-space-4">
      {/* Search */}
      <div className="flex items-center gap-space-2 max-w-sm">
        <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 flex-1">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
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
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-space-4 py-space-3 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-body-small" data-testid="user-table">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Email</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Name</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Roles</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-space-4 py-space-8 text-center text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin inline mr-space-2" />
                  Loading users…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-space-4 py-space-8 text-center text-muted-foreground">
                  {search.trim() ? "No users match your filter." : "No users found."}
                </td>
              </tr>
            ) : (
              filtered.map((user) => (
                <tr
                  key={user.id}
                  data-testid="user-row"
                  data-email={user.email}
                  className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
                  onClick={() => setSelectedUser(user)}
                >
                  <td className="px-space-4 py-space-3 text-foreground">{user.email}</td>
                  <td className="px-space-4 py-space-3 text-foreground">{user.name ?? "\u2014"}</td>
                  <td className="px-space-4 py-space-3">
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((r) => {
                        const colors = ROLE_COLORS[r.role];
                        return (
                          <span
                            key={r.id}
                            data-testid="user-role-badge"
                            data-role={r.role}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption ${colors.bg} ${colors.text}`}
                          >
                            <Shield className="w-3 h-3" />
                            {r.role}
                            {r.domainName && (
                              <span className="opacity-70">({r.domainName})</span>
                            )}
                            {!r.domainId && r.role !== "ADMIN" && r.role !== "COMPLIANCE_OFFICER" && (
                              <span className="opacity-70">(System)</span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-space-4 py-space-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-caption ${
                      user.status === "active"
                        ? "bg-success/20 text-success"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {user.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* User detail panel */}
      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
