/**
 * The shapes of the user administration services (invite, disable, reset link, the user list, the role matrix): what the Admin screens send and
 * what they get back. Dates are real `Date`s (a server action serializes them); nothing here carries a password hash, a token hash or another
 * tenant's data: a result holds only what the caller's authority reaches.
 */

import { z } from "zod";
import { RoleEnum, SCOPE_ID_MAX_LENGTH, type Role, type ScopeKind } from "@/types/schemas/rbac";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------------------------------------------------

const IdSchema = z.string().min(1).max(SCOPE_ID_MAX_LENGTH);

/**
 * One role an invitation carries: where it applies is named by ids, `productId` (a product), else `domainId` (a domain), else `tenantId` (a whole
 * tenant), else nothing (platform scope, ADMIN only), exactly as `assignRole` takes it. The service completes the full scope from the stored rows.
 */
export const InviteRoleInputSchema = z.object({
  role: RoleEnum,
  tenantId: IdSchema.optional(),
  domainId: IdSchema.optional(),
  productId: IdSchema.optional(),
});
export type InviteRoleInput = z.infer<typeof InviteRoleInputSchema>;

export const MAX_INVITED_ROLES = 50;

export const InviteUserInputSchema = z.object({
  email: z.string().max(320, "Enter a valid e-mail address."),
  roles: z.array(InviteRoleInputSchema).min(1, "Choose at least one role for the invited person.").max(MAX_INVITED_ROLES, `An invitation carries at most ${MAX_INVITED_ROLES} roles.`),
  /** How long the link lives, in hours (1 hour to 30 days); the default is 7 days. */
  ttlHours: z.number().optional(),
});
export type InviteUserInput = z.infer<typeof InviteUserInputSchema>;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Links (shown to the administrator, who hands them to the person: there is no e-mail service)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A one-time link. `token` is shown once and never stored in the clear. `path` is the route (`/invite/<token>`, `/reset/<token>`); `url` is the
 * absolute address when the server knows its public origin (`AUTH_URL`), else `null` (the page then joins its own origin to `path`).
 */
export type OneTimeLink = { token: string; path: string; url: string | null; expiresAt: Date };

export type InviteUserResult = OneTimeLink & {
  invitationId: string;
  /** The invited address, normalized (trimmed, lower case). */
  email: string;
  /** How many earlier pending invitations for the same address this one replaced (only the ones the inviter administers). */
  replacedInvitations: number;
};

export type ResetLinkResult = OneTimeLink & {
  userId: string;
  /** How many earlier reset links of this user stopped working. */
  invalidatedLinks: number;
};

export type SetUserDisabledResult = {
  userId: string;
  disabled: boolean;
  /** False when the user was already in that state: nothing was written. */
  changed: boolean;
  /** Reset links of the user that stopped working because of it (disabling only). */
  revokedResetLinks: number;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the lists show
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** A scope, with the names a person reads (never only raw ids). `label` is the whole place: `Platform`, `Acme`, `Acme / Payments`, `Acme / Payments / Checkout`. */
export type ScopeLabel = {
  kind: ScopeKind;
  scopeKey: string;
  tenantId: string | null;
  tenantName: string | null;
  domainId: string | null;
  domainName: string | null;
  productId: string | null;
  productName: string | null;
  label: string;
};

/**
 * A role held (`id` is the `user_roles` row, what `removeRole` takes) or promised by an invitation (`id` is null: nothing to remove yet).
 * `removeBlockedReason` is the service's own sentence when removing this row would be refused right now (your own administrator role, the last platform
 * administrator's), so a screen can disable the control and say why without ever reading a role name; `null` (or absent: invitation roles, which go with
 * the invitation) means nothing blocks it. The server still refuses it.
 */
export type ListedRole = { id: string | null; role: Role; scope: ScopeLabel; removeBlockedReason?: string | null };

export type UserStatus = "active" | "disabled" | "invited";

export type ListedUser = {
  /** `user`: an account. `invitation`: an invitation not yet accepted (there is no account), one row per pending invitation. */
  kind: "user" | "invitation";
  /** The user id, or for an invitation the invitation id. */
  id: string;
  userId: string | null;
  invitationId: string | null;
  email: string;
  name: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  /** The roles the caller may see: all of them for a platform administrator, only the ones held inside the tenants a tenant administrator administers. */
  roles: ListedRole[];
  /** When a pending invitation stops working (invitations only). */
  expiresAt: Date | null;
  /** May the caller disable / enable this user and make a reset link for them? (An invitation is revoked, not disabled: false.) */
  manageable: boolean;
  /** Is this the caller's own account? (One may not disable oneself.) */
  isSelf: boolean;
  /**
   * Why disabling this account is unavailable right now, in a sentence a screen can show (yourself; the last platform administrator; an account the caller
   * cannot change from here, which names no tenant and no role), or `null` when it is available. An invitation has no account: its sentence says so. The
   * server refuses it all the same.
   */
  disableBlockedReason: string | null;
};

export type ListUsersResult = { items: ListedUser[]; truncated: boolean };

export type PendingInvitation = {
  id: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
  invitedById: string;
  invitedByName: string | null;
  roles: ListedRole[];
};

/** One column of the role matrix: a tenant, a domain of it, or a product of a domain. */
export type MatrixScope = ScopeLabel & { kind: "TENANT" | "DOMAIN" | "PRODUCT"; depth: 0 | 1 | 2 };

/** One cell: the highest role the user holds AT that scope (`direct`), and the role they hold OVER it, inherited from a wider scope included (`effective`). */
export type MatrixCell = { direct: Role | null; effective: Role | null };

export type MatrixRow = {
  userId: string;
  email: string;
  name: string | null;
  status: Exclude<UserStatus, "invited">;
  /** By scope key. */
  cells: Record<string, MatrixCell>;
};

export type RoleMatrix = {
  tenantId: string;
  tenantName: string;
  scopes: MatrixScope[];
  rows: MatrixRow[];
  truncated: boolean;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The scopes a caller may grant a role in (the scope pickers)
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** One place a role may be granted: a tenant, a domain of it or a product of that domain, with the roles `grantAllowed` accepts there. */
export type GrantableScope = ScopeLabel & { kind: "TENANT" | "DOMAIN" | "PRODUCT"; depth: 0 | 1 | 2; roles: Role[] };

export type GrantableScopes = {
  /** Tenants first, each followed by its domains, each followed by its products. Only scopes the caller may grant at least one role in. */
  scopes: GrantableScope[];
  /** May the caller grant at platform scope (a platform administrator only; the role is ADMIN only)? */
  canGrantPlatform: boolean;
  /** The list was cut at the bound. */
  truncated: boolean;
};
