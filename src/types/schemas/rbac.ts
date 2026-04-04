import { z } from "zod";

export const RoleEnum = z.enum([
  "VIEWER",
  "AUTHOR",
  "STEWARD",
  "COMPLIANCE_OFFICER",
  "ADMIN",
]);

export type Role = z.infer<typeof RoleEnum>;

/**
 * Permission hierarchy — higher index = more permissive.
 * ADMIN > COMPLIANCE_OFFICER > STEWARD > AUTHOR > VIEWER
 */
export const ROLE_HIERARCHY: Role[] = [
  "VIEWER",
  "AUTHOR",
  "STEWARD",
  "COMPLIANCE_OFFICER",
  "ADMIN",
];

/**
 * Roles that must be system-level (domainId = null).
 */
export const SYSTEM_ONLY_ROLES: Role[] = ["COMPLIANCE_OFFICER", "ADMIN"];

/**
 * Roles that require a domainId.
 */
export const DOMAIN_SCOPED_ROLES: Role[] = ["VIEWER", "AUTHOR", "STEWARD"];

export const AssignRoleInputSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  role: RoleEnum,
  domainId: z.string().optional(),
});

export type AssignRoleInput = z.infer<typeof AssignRoleInputSchema>;

export const RemoveRoleInputSchema = z.object({
  id: z.string().min(1, "Role assignment ID is required"),
});

export type RemoveRoleInput = z.infer<typeof RemoveRoleInputSchema>;

export interface UserRole {
  id: string;
  userId: string;
  role: Role;
  domainId: string | null;
  domainName?: string;
  createdAt: Date;
}

export const UserWithRolesSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable().optional(),
  createdAt: z.date().optional(),
  roles: z.array(
    z.object({
      id: z.string(),
      role: RoleEnum,
      domainId: z.string().nullable(),
      domainName: z.string().optional(),
    })
  ),
});

export type UserWithRoles = z.infer<typeof UserWithRolesSchema>;

/** Role badge colors for UI */
export const ROLE_COLORS: Record<Role, { bg: string; text: string }> = {
  ADMIN: { bg: "bg-red-100 dark:bg-red-950", text: "text-red-700 dark:text-red-400" },
  STEWARD: { bg: "bg-amber-100 dark:bg-amber-950", text: "text-amber-700 dark:text-amber-400" },
  COMPLIANCE_OFFICER: { bg: "bg-purple-100 dark:bg-purple-950", text: "text-purple-700 dark:text-purple-400" },
  AUTHOR: { bg: "bg-blue-100 dark:bg-blue-950", text: "text-blue-700 dark:text-blue-400" },
  VIEWER: { bg: "bg-gray-100 dark:bg-gray-800", text: "text-gray-700 dark:text-gray-400" },
};
