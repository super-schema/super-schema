/**
 * User Management Service — Admin-only user CRUD with role data.
 *
 * For MVP, uses an in-memory store that can be seeded for testing.
 * All service functions return Result<T>.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { UserWithRoles } from "@/types/schemas/rbac";
import { UpdateUserInputSchema, type UpdateUserInput } from "@/types/schemas/user";
import { _getRoleStore } from "./rbac.service";

// ---------------------------------------------------------------------------
// In-memory user store (MVP)
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastLogin: Date | null;
  status: "active" | "inactive";
}

let userStore: UserRecord[] = [];

/** Reset store — for testing only */
export function _resetUserStore(): void {
  userStore = [];
}

/** Seed users — for testing only */
export function _seedUsers(users: UserRecord[]): void {
  userStore = [...users];
}

/** Get raw store — for testing only */
export function _getUserStore(): UserRecord[] {
  return userStore;
}

// ---------------------------------------------------------------------------
// getUsers — fetch all users with their roles (Admin only)
// ---------------------------------------------------------------------------

export async function getUsers(
  ctx: ServiceContext
): Promise<Result<UserWithRoles[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const roles = await _getRoleStore();
  const usersWithRoles: UserWithRoles[] = userStore.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    image: u.image,
    createdAt: u.createdAt,
    roles: roles
      .filter((r) => r.userId === u.id)
      .map((r) => ({
        id: r.id,
        role: r.role,
        domainId: r.domainId,
        domainName: r.domainName,
      })),
  }));

  return ok(usersWithRoles);
}

// ---------------------------------------------------------------------------
// getUserById — fetch single user with roles (Admin only)
// ---------------------------------------------------------------------------

export async function getUserById(
  id: string,
  ctx: ServiceContext
): Promise<Result<UserWithRoles>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const user = userStore.find((u) => u.id === id);
  if (!user) {
    return err({
      code: "NOT_FOUND",
      message: `User with ID "${id}" not found`,
      suggestedFix: "Verify the user ID and try again.",
    });
  }

  const roles = await _getRoleStore();
  return ok({
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    createdAt: user.createdAt,
    roles: roles
      .filter((r) => r.userId === user.id)
      .map((r) => ({
        id: r.id,
        role: r.role,
        domainId: r.domainId,
        domainName: r.domainName,
      })),
  });
}

// ---------------------------------------------------------------------------
// updateUser — update user name (Admin only)
// ---------------------------------------------------------------------------

export async function updateUser(
  input: UpdateUserInput,
  ctx: ServiceContext
): Promise<Result<UserRecord>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = UpdateUserInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the user input fields.",
    });
  }

  const userIndex = userStore.findIndex((u) => u.id === parsed.data.id);
  if (userIndex === -1) {
    return err({
      code: "NOT_FOUND",
      message: `User with ID "${parsed.data.id}" not found`,
      suggestedFix: "Verify the user ID and try again.",
    });
  }

  if (parsed.data.name !== undefined) {
    userStore[userIndex] = {
      ...userStore[userIndex],
      name: parsed.data.name,
      updatedAt: new Date(),
    };
  }

  return ok(userStore[userIndex]);
}
