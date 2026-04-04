"use client";

import { UserDataTable } from "@/components/custom/admin/UserDataTable";

/**
 * Admin Panel — Users tab (default).
 * Displays all users with their roles in a data table.
 */
export default function AdminUsersPage() {
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-3 text-foreground">Users</h2>
          <p className="text-body-small text-muted-foreground">
            Manage users and assign role-based access control.
          </p>
        </div>
      </div>
      <UserDataTable />
    </div>
  );
}
