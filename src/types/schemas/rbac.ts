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
 *
 * Frozen: the ladder is what every authorization decision ranks roles by (`@/lib/access`), so nothing may reorder it at runtime.
 */
export const ROLE_HIERARCHY: readonly Role[] = Object.freeze([
  "VIEWER",
  "AUTHOR",
  "STEWARD",
  "COMPLIANCE_OFFICER",
  "ADMIN",
] as const satisfies readonly Role[]);

/** True for exactly the five role names (a runtime guard for values read from the database or the wire). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLE_HIERARCHY as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Scopes (docs/superpowers/specs/2026-10-24-access-control-design.md, decisions 2 and 3)
//
// A role assignment is bound to a scope. Containment: GLOBAL ⊃ TENANT ⊃ DOMAIN ⊃ PRODUCT ⊃ entity; a tenant-level entity (no domain and no
// product) is governed by TENANT and GLOBAL assignments only. The rules live in `@/lib/access`; this file holds the types and the validity
// constants they share with the input schemas.
// ---------------------------------------------------------------------------

/** The longest id a scope or resource may carry (database ids are 25-character cuids; the cap keeps every check bounded). */
export const SCOPE_ID_MAX_LENGTH = 128;

/**
 * What an id may look like in a scope: no whitespace, no control character and no ":" (the separator of a scope key, `T:<id>`), so a key
 * parses back unambiguously. Combined with `SCOPE_ID_MAX_LENGTH` (the pattern alone does not bound the length).
 */
export const SCOPE_ID_PATTERN = /^[^\s:\p{Cc}]+$/u;

const ScopeIdSchema = z.string().min(1).max(SCOPE_ID_MAX_LENGTH).regex(SCOPE_ID_PATTERN);

export const ScopeKindEnum = z.enum(["GLOBAL", "TENANT", "DOMAIN", "PRODUCT"]);

export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLOBAL") }),
  z.object({ kind: z.literal("TENANT"), tenantId: ScopeIdSchema }),
  z.object({ kind: z.literal("DOMAIN"), tenantId: ScopeIdSchema, domainId: ScopeIdSchema }),
  z.object({ kind: z.literal("PRODUCT"), tenantId: ScopeIdSchema, domainId: ScopeIdSchema, productId: ScopeIdSchema }),
]);

/** Where a role applies: the whole platform, one tenant, one domain of a tenant, or one product of a domain. */
export type Scope = z.infer<typeof ScopeSchema>;
export type ScopeKind = Scope["kind"];

export const AssignmentSchema = z.object({ role: RoleEnum, scope: ScopeSchema });

/** One role held in one scope (a `user_roles` row, read as its scope). */
export type Assignment = z.infer<typeof AssignmentSchema>;

/**
 * The place of a thing in the scope tree: its tenant, and the domain and product it hangs under when it has them. An entity at tenant
 * level has neither; a domain-level asset has no product.
 */
export type ResourceRef = { tenantId: string; domainId?: string | null; productId?: string | null };

/**
 * The only role a GLOBAL (platform) assignment may carry. Every other role is bound to a tenant, a domain or a product (decision 3:
 * any role at any of those scopes, COMPLIANCE_OFFICER and ADMIN at tenant scope included).
 */
export const GLOBAL_SCOPE_ROLES: readonly Role[] = Object.freeze(["ADMIN"] as const satisfies readonly Role[]);

/**
 * Where a role is assigned, by the ids the caller names: `productId` (a product), else `domainId` (a domain), else `tenantId` (a whole
 * tenant), else nothing (platform scope, ADMIN only). The service completes the full scope from the stored rows and refuses ids that
 * disagree (`rbac.service.assignRole`), so the tenant of a domain role is never taken from the caller.
 */
export const AssignRoleInputSchema = z.object({
  userId: z.string().min(1, "userId is required"),
  role: RoleEnum,
  tenantId: z.string().optional(),
  domainId: z.string().optional(),
  productId: z.string().optional(),
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
