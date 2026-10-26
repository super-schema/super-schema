/**
 * The user directory: who exists and what they hold, as far as the caller's authority reaches (`listUsers`), and the role matrix of one tenant
 * (`getRoleMatrix`). Reads only; they change nothing and write no audit entry.
 *
 * What a caller sees is decided from their STORED assignments (read by id, never the context's label):
 *  - a platform administrator: every user with every role (a legacy platform row included), and every pending invitation;
 *  - a tenant administrator: the users who hold a role in a tenant they administer, with ONLY the roles held in those tenants (a platform role, or a role in
 *    another tenant, is not shown and not hinted at), and the pending invitations that lie entirely in those tenants. A roleless account is invisible to them;
 *  - anyone else: the generic refusal.
 * A user is `manageable` (may be disabled, enabled, given a reset link) when `reaches` says so: the same rule `setUserDisabled` and `createResetLink` apply.
 */

import { assignmentFromRow, assignmentsFromRows, ROLE_ROW_SELECT } from "@/lib/access/assignments";
import { loadActorAssignments } from "@/lib/access/granter";
import { effectiveRole, grantAllowed } from "@/lib/access/policy";
import { scopeKey } from "@/lib/access/scope";
import { prisma } from "@/lib/db";
import { ROLE_HIERARCHY, type Role, type Scope } from "@/types/schemas/rbac";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type {
  GrantableScope,
  GrantableScopes,
  ListUsersResult,
  ListedRole,
  ListedUser,
  MatrixCell,
  MatrixRow,
  MatrixScope,
  RoleMatrix,
} from "@/types/schemas/user-admin";
import {
  ACCOUNT_OUT_OF_REACH_MESSAGE,
  GRANTING_ROLE,
  LAST_ADMIN_ROLE_MESSAGE,
  LAST_PLATFORM_ADMIN_DISABLE_MESSAGE,
  SELF_ADMIN_ROLE_MESSAGE,
  SELF_DISABLE_MESSAGE,
  administeredBy,
  administersSomething,
  administersTenant,
  answering,
  forbidden,
  isAdministrative,
  reaches,
} from "./admin-shared";
import { pendingInvitationsInReach } from "./invitation.service";
import { labelScopes } from "./scope-labels";

/** The most users one list or matrix holds; a bigger directory says `truncated` instead of answering without end. */
export const MAX_LISTED_USERS = 2000;

type StoredRole = { id: string; role: string; scopeKey: string; tenantId: string | null; domainId: string | null; productId: string | null };

/** The scope of a stored role row; for a row that is not a valid assignment only a platform row (a legacy one, which an administrator can still remove) has one. */
function scopeOfStoredRow(row: StoredRole): Scope | null {
  const assignment = assignmentFromRow(row);
  if (assignment) return assignment.scope;
  return row.scopeKey === "G" ? { kind: "GLOBAL" } : null;
}

const notFoundTenant = <T>(): Result<T> => err({ code: "NOT_FOUND", message: "Tenant not found", suggestedFix: "Verify the tenant and try again." });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The users the caller reaches (oldest account first), then the invitations they reach that nobody has accepted yet (one `invited` row each, with no
 * account behind it). `options.tenantId` narrows to the people with a role in that tenant (and to the roles held there); a tenant the caller does not
 * administer lists nothing, exactly like one that has nobody in it. Each user has `status` (`active`, `disabled`), `lastLoginAt`, and the roles with the
 * names of their scopes (tenant, domain, product) rather than ids; each role carries the id `removeRole` takes.
 */
export async function listUsers(ctx: ServiceContext, options: { tenantId?: string } = {}): Promise<Result<ListUsersResult>> {
  return answering("listUsers", async () => {
    const actor = await loadActorAssignments(prisma, ctx.userId);
    const administered = actor ? administeredBy(actor) : null;
    if (!actor || !administered || !administersSomething(administered)) return forbidden();

    const filter = typeof options.tenantId === "string" && options.tenantId !== "" ? options.tenantId : null;
    // The tenants whose people are listed: all (a platform administrator, no filter), the one asked for when it is theirs, or the ones they administer.
    const tenantIds: string[] | null = administered.platform
      ? filter === null ? null : [filter]
      : filter === null ? [...administered.tenantIds] : administered.tenantIds.has(filter) ? [filter] : [];

    const rows =
      tenantIds !== null && tenantIds.length === 0
        ? []
        : await prisma.user.findMany({
            where: tenantIds === null ? {} : { roles: { some: { tenantId: { in: tenantIds } } } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: MAX_LISTED_USERS + 1,
            select: {
              id: true,
              name: true,
              email: true,
              disabledAt: true,
              lastLoginAt: true,
              createdAt: true,
              roles: { orderBy: { createdAt: "asc" }, select: { id: true, ...ROLE_ROW_SELECT } },
            },
          });
    const truncated = rows.length > MAX_LISTED_USERS;
    const users = rows.slice(0, MAX_LISTED_USERS);

    // The roles the caller may see of each user (a tenant administrator: only the ones held in the tenants they administer; with a filter: that tenant's).
    const visibleOf = (roles: StoredRole[]): StoredRole[] =>
      roles.filter((row) => {
        if (filter !== null) return row.tenantId === filter;
        return administered.platform || (row.tenantId !== null && administered.tenantIds.has(row.tenantId));
      });

    // How many ENABLED platform administrators there are: only a platform administrator sees platform rows, so only they need it. A platform administrator
    // who is the only enabled one cannot be disabled and keeps the platform role (the services refuse both; this is what the screen shows as the reason).
    const enabledPlatformAdmins = administered.platform ? await prisma.userRole.count({ where: { role: GRANTING_ROLE, scopeKey: "G", user: { disabledAt: null } } }) : 0;
    const isLastPlatformAdmin = (user: { disabledAt: Date | null; roles: StoredRole[] }): boolean =>
      enabledPlatformAdmins === 1 && user.disabledAt === null && user.roles.some((row) => row.scopeKey === "G" && row.role === GRANTING_ROLE);

    const shown = users.map((user) => ({ user, visible: visibleOf(user.roles) }));
    const scopes = shown.flatMap(({ visible }) => visible.flatMap((row) => scopeOfStoredRow(row) ?? []));
    const invited = tenantIds !== null && tenantIds.length === 0 ? [] : await pendingInvitationsInReach(administered);
    const invitedFiltered = filter === null ? invited : invited.filter((invitation) => invitation.roles.some((role) => role.scope.tenantId === filter));
    const labels = await labelScopes(prisma, scopes);

    const items: ListedUser[] = shown.map(({ user, visible }) => {
      const manageable = reaches(administered, user.roles);
      const isSelf = user.id === ctx.userId;
      const last = isLastPlatformAdmin(user);
      return {
        kind: "user",
        id: user.id,
        userId: user.id,
        invitationId: null,
        email: user.email,
        name: user.name,
        status: user.disabledAt ? "disabled" : "active",
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        roles: visible.flatMap((row): ListedRole[] => {
          const scope = scopeOfStoredRow(row);
          const label = scope ? labels.get(scopeKey(scope)) : undefined;
          // The refusals `removeRole` makes for this row (the sentences are the service's own): the last platform administrator's platform role, your own administrator role.
          const removeBlockedReason =
            last && row.scopeKey === "G" && row.role === GRANTING_ROLE ? LAST_ADMIN_ROLE_MESSAGE : isSelf && isAdministrative(row.role) ? SELF_ADMIN_ROLE_MESSAGE : null;
          return label ? [{ id: row.id, role: row.role as Role, scope: label, removeBlockedReason }] : [];
        }),
        expiresAt: null,
        manageable,
        isSelf,
        disableBlockedReason: last ? LAST_PLATFORM_ADMIN_DISABLE_MESSAGE : isSelf ? SELF_DISABLE_MESSAGE : manageable ? null : ACCOUNT_OUT_OF_REACH_MESSAGE,
      };
    });

    for (const invitation of invitedFiltered) {
      items.push({
        kind: "invitation",
        id: invitation.id,
        userId: null,
        invitationId: invitation.id,
        email: invitation.email,
        name: null,
        status: "invited",
        lastLoginAt: null,
        createdAt: invitation.createdAt,
        roles: invitation.roles,
        expiresAt: invitation.expiresAt,
        manageable: false,
        isSelf: false,
        disableBlockedReason: "An invitation is revoked, not disabled",
      });
    }
    return ok({ items, truncated });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// getRoleMatrix
// ---------------------------------------------------------------------------------------------------------------------------------------------

const rankOf = (role: string): number => ROLE_HIERARCHY.indexOf(role as Role);

/** The highest of the roles, or null for none. */
function highest(roles: readonly string[]): Role | null {
  let best: Role | null = null;
  for (const role of roles) if (rankOf(role) > (best === null ? -1 : rankOf(best))) best = role as Role;
  return best;
}

/**
 * Users by scopes for ONE tenant: a column for the tenant, each of its domains and each domain's products; a row for every user who holds a role in the
 * tenant; in each cell the highest role the user holds AT that scope (`direct`) and the role they hold OVER it, a wider scope's included (`effective`).
 * Only what the caller may see: a tenant administrator gets the matrix of a tenant they administer and of no other (the one answer, `NOT_FOUND`, for
 * another tenant and for one that does not exist), and sees only the roles held in that tenant; a platform administrator's `effective` also counts
 * a platform role.
 */
export async function getRoleMatrix(tenantId: string, ctx: ServiceContext): Promise<Result<RoleMatrix>> {
  return answering("getRoleMatrix", async () => {
    const actor = await loadActorAssignments(prisma, ctx.userId);
    const administered = actor ? administeredBy(actor) : null;
    if (!actor || !administered || !administersSomething(administered)) return forbidden();
    if (typeof tenantId !== "string" || tenantId === "" || !administersTenant(administered, tenantId)) return notFoundTenant();

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        domains: { orderBy: { name: "asc" }, select: { id: true, name: true, products: { orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      },
    });
    if (!tenant) return notFoundTenant();

    type Column = { scope: Scope; depth: 0 | 1 | 2 };
    const columns: Column[] = [{ scope: { kind: "TENANT", tenantId: tenant.id }, depth: 0 }];
    for (const domain of tenant.domains) {
      columns.push({ scope: { kind: "DOMAIN", tenantId: tenant.id, domainId: domain.id }, depth: 1 });
      for (const product of domain.products) columns.push({ scope: { kind: "PRODUCT", tenantId: tenant.id, domainId: domain.id, productId: product.id }, depth: 2 });
    }
    const labels = await labelScopes(prisma, columns.map((column) => column.scope));
    const scopes: MatrixScope[] = columns.flatMap((column) => {
      const label = labels.get(scopeKey(column.scope));
      return label && column.scope.kind !== "GLOBAL" ? [{ ...label, kind: column.scope.kind, depth: column.depth }] : [];
    });

    // The people with a role in the tenant. A platform administrator's cells also count the rest of what they hold (a platform role makes them an
    // administrator over everything); a tenant administrator only ever sees the tenant's own rows.
    const found = await prisma.user.findMany({
      where: { roles: { some: { tenantId: tenant.id } } },
      orderBy: [{ email: "asc" }, { id: "asc" }],
      take: MAX_LISTED_USERS + 1,
      select: {
        id: true,
        name: true,
        email: true,
        disabledAt: true,
        roles: { where: administered.platform ? {} : { tenantId: tenant.id }, select: ROLE_ROW_SELECT },
      },
    });
    const truncated = found.length > MAX_LISTED_USERS;

    const rows: MatrixRow[] = found.slice(0, MAX_LISTED_USERS).map((user) => {
      const assignments = assignmentsFromRows(user.roles);
      const cells: Record<string, MatrixCell> = {};
      for (const column of columns) {
        const key = scopeKey(column.scope);
        const resource =
          column.scope.kind === "TENANT"
            ? { tenantId: tenant.id }
            : column.scope.kind === "DOMAIN"
              ? { tenantId: tenant.id, domainId: column.scope.domainId }
              : column.scope.kind === "PRODUCT"
                ? { tenantId: tenant.id, domainId: column.scope.domainId, productId: column.scope.productId }
                : { tenantId: tenant.id };
        cells[key] = {
          direct: highest(user.roles.filter((row) => row.scopeKey === key).map((row) => row.role)),
          effective: effectiveRole(assignments, resource),
        };
      }
      return { userId: user.id, email: user.email, name: user.name, status: user.disabledAt ? "disabled" : "active", cells };
    });

    return ok({ tenantId: tenant.id, tenantName: tenant.name, scopes, rows, truncated });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// listGrantableScopes
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The most scopes one picker is offered; a larger platform says `truncated` instead of answering without end. */
export const MAX_GRANTABLE_SCOPES = 1500;

/**
 * The places the caller may grant a role in, for the scope pickers of the invitation and role screens: every tenant they administer (a platform administrator:
 * every active tenant) with its domains and their products, each with the roles `grantAllowed` accepts there, from the caller's STORED assignments. A scope
 * with no role the caller may grant is left out, so a picker can only offer what the service will accept; the service judges again on submit. Platform scope is
 * not a row (it has no tenant): `canGrantPlatform` says whether the caller may grant it (the role there is ADMIN only).
 */
export async function listGrantableScopes(ctx: ServiceContext): Promise<Result<GrantableScopes>> {
  return answering("listGrantableScopes", async () => {
    const actor = await loadActorAssignments(prisma, ctx.userId);
    const administered = actor ? administeredBy(actor) : null;
    if (!actor || !administered || !administersSomething(administered)) return forbidden();

    const tenants = await prisma.tenant.findMany({
      where: administered.platform ? { isActive: true } : { id: { in: [...administered.tenantIds] }, isActive: true },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      take: MAX_GRANTABLE_SCOPES + 1,
      select: {
        id: true,
        name: true,
        domains: { orderBy: { name: "asc" }, select: { id: true, name: true, products: { orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      },
    });

    const scopes: GrantableScope[] = [];
    let truncated = tenants.length > MAX_GRANTABLE_SCOPES;
    const offer = (scope: Scope, label: Omit<GrantableScope, "roles" | "scopeKey" | "kind" | "depth" | "label"> & { names: string[] }, depth: 0 | 1 | 2): void => {
      if (scope.kind === "GLOBAL") return;
      if (scopes.length >= MAX_GRANTABLE_SCOPES) {
        truncated = true;
        return;
      }
      const roles = ROLE_HIERARCHY.filter((role) => grantAllowed(actor, role, scope));
      if (roles.length === 0) return;
      const { names, ...ids } = label;
      scopes.push({ ...ids, kind: scope.kind, scopeKey: scopeKey(scope), depth, label: names.join(" / "), roles: [...roles] });
    };
    for (const tenant of tenants.slice(0, MAX_GRANTABLE_SCOPES)) {
      const base = { tenantId: tenant.id, tenantName: tenant.name };
      offer({ kind: "TENANT", tenantId: tenant.id }, { ...base, domainId: null, domainName: null, productId: null, productName: null, names: [tenant.name] }, 0);
      for (const domain of tenant.domains) {
        offer(
          { kind: "DOMAIN", tenantId: tenant.id, domainId: domain.id },
          { ...base, domainId: domain.id, domainName: domain.name, productId: null, productName: null, names: [tenant.name, domain.name] },
          1
        );
        for (const product of domain.products) {
          offer(
            { kind: "PRODUCT", tenantId: tenant.id, domainId: domain.id, productId: product.id },
            { ...base, domainId: domain.id, domainName: domain.name, productId: product.id, productName: product.name, names: [tenant.name, domain.name, product.name] },
            2
          );
        }
      }
    }
    const canGrantPlatform = administered.platform && ROLE_HIERARCHY.some((role) => grantAllowed(actor, role, { kind: "GLOBAL" }));
    return ok({ scopes, canGrantPlatform, truncated });
  });
}
