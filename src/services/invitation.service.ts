/**
 * Invitations: invite a person by link with roles already granted, revoke an invitation that has not been used, and list the pending ones.
 *
 * WHO may do what is decided here, from the actor's STORED assignments read inside a SERIALIZABLE transaction (never the context's label or its cached
 * assignments), exactly as `assignRole` does:
 *  - `inviteUser`: the actor must be allowed by `grantAllowed` for EVERY role and scope asked for (a tenant administrator invites into their tenant, its
 *    domains and products, and nowhere else; only a platform administrator invites to the platform scope), the scope is completed from the stored rows
 *    (an id that names nothing, or two ids that disagree, is the generic refusal for a tenant administrator and a "not found" for a platform one), the
 *    address is normalized, an address that already has an account is refused, and earlier pending invitations for the same address that the actor administers
 *    are replaced (revoked and audited) by the new one;
 *  - `revokeInvitation`: pending invitations only; one that is missing, used, expired, or outside the actor's reach answers the same "not found";
 *  - `listPendingInvitations`: what the actor reaches.
 * An invitation is IN REACH of a tenant administrator when every role it carries (the ones whose place still exists) lies in a tenant they administer and
 * it carries at least one; a platform administrator reaches every invitation.
 *
 * Every function answers `Result<T, ServiceError>` and never throws; every change writes its audit entry in the same transaction. The audit log holds
 * what was granted and by whom, never the invited address or the token.
 */

import { grantAllowed } from "@/lib/access/policy";
import { loadActorAssignments } from "@/lib/access/granter";
import { isValidAssignment, scopeKey } from "@/lib/access/scope";
import { inviteLink } from "@/lib/auth/links";
import { checkInvitation, completeAssignment, insertInvitation } from "@/lib/auth/tokens";
import { prisma } from "@/lib/db";
import { runSerializable } from "@/lib/serializable-transaction";
import { err, ok, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { Assignment } from "@/types/schemas/rbac";
import { InviteUserInputSchema, type InviteUserInput, type InviteUserResult, type ListedRole, type PendingInvitation } from "@/types/schemas/user-admin";
import {
  administeredBy,
  answering,
  commonTenantId,
  forbidden,
  holdsGrantingRole,
  invitationNotFound,
  isPlatformAdmin,
  resolveTarget,
  roleSummary,
  type Administered,
  type Tx,
} from "./admin-shared";
import { labelScopes } from "./scope-labels";

type InvitationRoleRow = { role: string; scopeKey: string };

/** The roles of an invitation as assignments the policy understands; one whose place no longer exists (or that is no longer valid) grants nothing and is left out. */
async function completeRoles(tx: Tx, rows: readonly InvitationRoleRow[]): Promise<Assignment[]> {
  const assignments: Assignment[] = [];
  for (const row of rows) {
    const assignment = await completeAssignment(tx, row);
    if (assignment) assignments.push(assignment);
  }
  return assignments;
}

/** Is the invitation within what the actor administers? (See the header.) */
function invitationInReach(administered: Administered, assignments: readonly Assignment[]): boolean {
  if (administered.platform) return true;
  return assignments.length > 0 && assignments.every((assignment) => assignment.scope.kind !== "GLOBAL" && administered.tenantIds.has(assignment.scope.tenantId));
}

const tenantsOf = (assignments: readonly Assignment[]): Array<string | null> => assignments.map((a) => (a.scope.kind === "GLOBAL" ? null : a.scope.tenantId));

/** The audit entry of an invitation that stopped being pending without being used (revoked by an administrator, or replaced by a newer one). */
async function auditRevocation(
  tx: Tx,
  entry: { invitationId: string; actorId: string; roles: readonly InvitationRoleRow[]; assignments: readonly Assignment[]; expiresAt: Date; reason: "revoked" | "replaced"; replacedBy?: string }
): Promise<void> {
  await tx.auditLog.create({
    data: {
      action: "INVITATION_REVOKED",
      entityType: "Invitation",
      entityId: entry.invitationId,
      userId: entry.actorId,
      tenantId: commonTenantId(tenantsOf(entry.assignments)),
      beforeState: { roles: roleSummary(entry.roles), expiresAt: entry.expiresAt.toISOString() },
      afterState: { reason: entry.reason, ...(entry.replacedBy ? { replacedBy: entry.replacedBy } : {}) },
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// inviteUser
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Invites `email` with `roles`. Answers the one-time link (`token`, `path`, `url`) and its expiry; the link is shown to the administrator, who hands it
 * over. Refusals: `FORBIDDEN` (no authority for some role or scope, with one generic text), `NOT_FOUND` (a platform administrator named a scope that does
 * not exist), `VALIDATION_ERROR` (a bad address, no role, a role that is not valid at that scope, a lifetime out of range), `ACCOUNT_EXISTS` (the address
 * already has an account: told to a platform administrator and to an administrator who can see that account), and `INVITATION_REFUSED` (the same address
 * for an administrator who cannot see the account: the answer does not say whether there is one).
 */
export async function inviteUser(input: InviteUserInput, ctx: ServiceContext): Promise<Result<InviteUserResult>> {
  const parsed = InviteUserInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({ code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, details: { field: String(parsed.error.issues[0].path[0] ?? "") }, suggestedFix: "Check the invitation fields." });
  }
  const { email: rawEmail, roles, ttlHours } = parsed.data;
  // The address and the lifetime are judged before anything is looked up (they say nothing about anyone).
  const early = checkInvitation({ email: rawEmail, roles: [], ttlHours });
  if (!early.success) return early;

  return answering("inviteUser", () =>
    runSerializable(async (tx): Promise<Result<InviteUserResult>> => {
      const actor = await loadActorAssignments(tx, ctx.userId);
      if (!actor || !holdsGrantingRole(actor)) return forbidden();
      const administered = administeredBy(actor);
      const platform = isPlatformAdmin(actor);

      // WHERE and WHETHER, for every role: the scope from the stored rows, a valid assignment, and an actor who may grant it.
      const wanted: Assignment[] = [];
      for (const entry of roles) {
        const target = await resolveTarget(tx, { tenantId: entry.tenantId, domainId: entry.domainId, productId: entry.productId }, platform);
        if (!target.success) return target;
        if (!isValidAssignment(entry.role, target.data)) {
          return err({
            code: "VALIDATION_ERROR",
            message: `${entry.role} cannot be assigned at system level; only ADMIN can`,
            details: { field: "roles" },
            suggestedFix: `Choose a tenant, a domain or a product for ${entry.role}.`,
          });
        }
        if (!grantAllowed(actor, entry.role, target.data)) return forbidden();
        wanted.push({ role: entry.role, scope: target.data });
      }
      const checked = checkInvitation({ email: rawEmail, roles: wanted, ttlHours });
      if (!checked.success) return checked;

      // An address that already has an account is not invited. Told plainly to who may know it (a platform administrator, or one who administers a tenant
      // the account holds a role in: they see that user in their list anyway); everyone else gets an answer that does not say.
      const existing = await tx.user.findUnique({ where: { email: checked.data.email }, select: { id: true, roles: { select: { scopeKey: true, tenantId: true } } } });
      if (existing) {
        const mayKnow = platform || (existing.roles.length > 0 && existing.roles.some((row) => row.tenantId !== null && administered.tenantIds.has(row.tenantId)));
        return mayKnow
          ? err({ code: "ACCOUNT_EXISTS", message: "An account with this address already exists. Assign roles to it instead of inviting it.", details: { field: "email" }, suggestedFix: "Open the user and assign the roles." })
          : err({
              code: "INVITATION_REFUSED",
              message: "This address cannot be invited. If the person already has an account, ask an administrator to assign their roles.",
              details: { field: "email" },
              suggestedFix: "Check the address, or ask an administrator.",
            });
      }

      const created = await insertInvitation(tx, { ...checked.data, createdById: ctx.userId });
      if (!created.success) return created;

      // One pending invitation per address: the earlier ones the actor administers are replaced. Another administrator's invitation into a tenant this actor
      // does not administer is left alone (replacing it would let one tenant cancel another's onboarding).
      const earlier = await tx.invitation.findMany({
        where: { emailLower: checked.data.email, usedAt: null, expiresAt: { gt: new Date() }, id: { not: created.data.invitationId } },
        select: { id: true, expiresAt: true, roles: { select: { role: true, scopeKey: true } } },
      });
      let replaced = 0;
      for (const old of earlier) {
        const assignments = await completeRoles(tx, old.roles);
        if (!invitationInReach(administered, assignments)) continue;
        await tx.invitation.delete({ where: { id: old.id } });
        await auditRevocation(tx, { invitationId: old.id, actorId: ctx.userId, roles: old.roles, assignments, expiresAt: old.expiresAt, reason: "replaced", replacedBy: created.data.invitationId });
        replaced++;
      }

      return ok({
        invitationId: created.data.invitationId,
        email: checked.data.email,
        token: created.data.token,
        ...inviteLink(created.data.token),
        expiresAt: created.data.expiresAt,
        replacedInvitations: replaced,
      });
    })
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// revokeInvitation
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Revokes a PENDING invitation (not used, not expired): the invitation is deleted (its address and roles go with it; the audit entry stays), and its
 * link answers the same generic "this link is not valid" as any dead one. A missing invitation, one already used or expired, and one the actor has no
 * authority over are the same `NOT_FOUND`.
 */
export async function revokeInvitation(invitationId: string, ctx: ServiceContext): Promise<Result<void>> {
  return answering("revokeInvitation", () =>
    runSerializable(async (tx): Promise<Result<void>> => {
      const actor = await loadActorAssignments(tx, ctx.userId);
      if (!actor || !holdsGrantingRole(actor)) return forbidden();

      const found = typeof invitationId === "string" && invitationId.trim() !== "" ? await tx.invitation.findUnique({ where: { id: invitationId }, select: { id: true, usedAt: true, expiresAt: true, roles: { select: { role: true, scopeKey: true } } } }) : null;
      if (!found || found.usedAt !== null || found.expiresAt.getTime() <= Date.now()) return invitationNotFound();

      const assignments = await completeRoles(tx, found.roles);
      if (!invitationInReach(administeredBy(actor), assignments)) return invitationNotFound();

      await tx.invitation.delete({ where: { id: found.id } });
      await auditRevocation(tx, { invitationId: found.id, actorId: ctx.userId, roles: found.roles, assignments, expiresAt: found.expiresAt, reason: "revoked" });
      return ok(undefined);
    })
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// listPendingInvitations
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The invitations that can still be used (not used, not expired) and that the actor reaches, newest first, with the roles they grant by name. */
export async function listPendingInvitations(ctx: ServiceContext): Promise<Result<PendingInvitation[]>> {
  return answering("listPendingInvitations", async () => {
    const actor = await loadActorAssignments(prisma, ctx.userId);
    if (!actor || !holdsGrantingRole(actor)) return forbidden();
    return ok(await pendingInvitationsInReach(administeredBy(actor)));
  });
}

/** At most this many pending invitations are read for a list (an administrator does not have more live ones than they can read). */
const MAX_PENDING_LISTED = 1000;

/**
 * The pending invitations (not used, not expired) within `administered`'s reach, newest first, the roles by name. For the callers that already
 * decided the actor may administer something (the invitation list, and the user list that shows them as "invited" rows).
 */
export async function pendingInvitationsInReach(administered: Administered): Promise<PendingInvitation[]> {
  const rows = await prisma.invitation.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, emailLower: true, createdAt: true, expiresAt: true, createdById: true, createdBy: { select: { name: true } }, roles: { select: { role: true, scopeKey: true } } },
    take: MAX_PENDING_LISTED,
  });

  const pending: Array<{ row: (typeof rows)[number]; assignments: Assignment[] }> = [];
  for (const row of rows) {
    const assignments = await completeRoles(prisma, row.roles);
    if (invitationInReach(administered, assignments)) pending.push({ row, assignments });
  }
  const labels = await labelScopes(prisma, pending.flatMap((entry) => entry.assignments.map((a) => a.scope)));

  return pending.map(({ row, assignments }): PendingInvitation => ({
    id: row.id,
    email: row.emailLower,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    invitedById: row.createdById,
    invitedByName: row.createdBy.name,
    roles: assignments.flatMap((assignment): ListedRole[] => {
      const label = labels.get(scopeKey(assignment.scope));
      return label ? [{ id: null, role: assignment.role, scope: label }] : [];
    }),
  }));
}
