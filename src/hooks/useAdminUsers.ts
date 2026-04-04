/**
 * Admin Users hooks — wrappers for user/role management oRPC calls.
 * Provides query and mutation hooks for the Admin Users tab.
 */

import { useState, useCallback } from "react";
import type { UserWithRoles } from "@/types/schemas/rbac";
import type { AssignRoleInput } from "@/types/schemas/rbac";

export function useAdminUsers() {
  const [users, setUsers] = useState<UserWithRoles[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // In production: call oRPC admin.users.getAll
      setUsers([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch users");
    } finally {
      setLoading(false);
    }
  }, []);

  const assignRole = useCallback(async (input: AssignRoleInput) => {
    try {
      // In production: call oRPC admin.users.assignRole
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to assign role");
    }
  }, []);

  const removeRole = useCallback(async (id: string) => {
    try {
      // In production: call oRPC admin.users.removeRole
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove role");
    }
  }, []);

  return { users, loading, error, fetchUsers, assignRole, removeRole };
}
