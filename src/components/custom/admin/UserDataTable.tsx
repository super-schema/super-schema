"use client";

import { useState } from "react";
import { Search, Shield } from "lucide-react";
import { ROLE_COLORS, type Role } from "@/types/schemas/rbac";
import { UserDetailPanel } from "./UserDetailPanel";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  roles: { id: string; role: Role; domainId: string | null; domainName?: string }[];
  lastLogin?: string;
  status: string;
}

// Mock data for initial display
const MOCK_USERS: UserRow[] = [
  {
    id: "user-1",
    email: "admin@example.com",
    name: "Admin User",
    roles: [{ id: "r1", role: "ADMIN", domainId: null }],
    status: "active",
  },
];

export function UserDataTable() {
  const [search, setSearch] = useState("");
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);
  const users = MOCK_USERS;

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
            placeholder="Filter by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
          />
        </div>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-body-small">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Email</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Name</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Roles</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => (
              <tr
                key={user.id}
                className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => setSelectedUser(user)}
              >
                <td className="px-space-4 py-space-3 text-foreground">{user.email}</td>
                <td className="px-space-4 py-space-3 text-foreground">{user.name ?? "—"}</td>
                <td className="px-space-4 py-space-3">
                  <div className="flex flex-wrap gap-1">
                    {user.roles.map((r) => {
                      const colors = ROLE_COLORS[r.role];
                      return (
                        <span
                          key={r.id}
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
            ))}
          </tbody>
        </table>
      </div>

      {/* User detail panel */}
      {selectedUser && (
        <UserDetailPanel
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
        />
      )}
    </div>
  );
}
