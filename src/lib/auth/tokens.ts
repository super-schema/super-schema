/**
 * Invitation and password-reset tokens (access-control design, decisions 6 and 8, Review Focus "tokens").
 *
 * A token is 32 random bytes (`crypto.randomBytes`), shown once as base64url (43 characters); only its SHA-256 is stored, so a copy of the database
 * holds nothing that opens a link. Single use is ONE atomic statement: `UPDATE ... SET usedAt = now WHERE <this token> AND usedAt IS NULL AND
 * expiresAt > now` (Prisma `updateMany`, which answers how many rows it changed): two concurrent uses of one token cannot both change a row, so
 * only one of them proceeds. The claim runs in the SAME transaction as what the token allows (the account, its roles, the new password), so a
 * failure after the claim puts the token back.
 *
 * Which table carries what: an INVITATION is `invitations` (it has the invited e-mail, the roles it grants, who made it), a PASSWORD RESET is
 * `auth_tokens` of kind RESET. (`AuthTokenKind.INVITE` exists in the schema and is not used.)
 *
 * A wrong, a malformed, an expired and a used token get ONE answer, `INVALID_LINK_MESSAGE`, in one shape: nothing tells which it was. A refusal that
 * is about the password (the policy) or the e-mail (already an account) is a different answer, and it does not spend the token.
 *
 * Who may INVITE with which roles, and revoking an invitation, are decisions of the administration service (`inviteUser`, `revokeInvitation`,
 * `src/services/invitation.service.ts`); `createInvitation` accepts the roles and scopes that `isValidAssignment` accepts. At ACCEPTANCE the creator is
 * judged again (`acceptInvitation`): a role the creator can no longer grant is skipped and listed in the audit entry.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { grantAllowed, isValidAssignment, parseScopeKey, scopeKey, type Assignment, type Scope } from "@/lib/access";
import { loadActorAssignments } from "@/lib/access/granter";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";
import { hashPassword } from "@/lib/auth/password-hash";
import { normalizeEmail, validatePassword } from "@/lib/auth/password-policy";
import { isRole, type Role } from "@/types/schemas/rbac";
import { err, ok, type Result } from "@/types/result";

export { INVALID_LINK_MESSAGE };

export const INVITATION_TTL_HOURS = 7 * 24;
export const RESET_TTL_HOURS = 1;
/** The longest an invitation may live: 30 days. */
export const MAX_TTL_HOURS = 30 * 24;
const MAX_ROLES_PER_INVITATION = 50;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 120;
const HOUR_MS = 60 * 60 * 1000;
/** base64url of 32 bytes. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh token and what is stored for it. */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/** What is stored for a token: the SHA-256 of the token text, in hex. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Is this the shape of a token we issue? (Checked before anything is looked up: a malformed one is refused without a query.) */
export function isTokenShape(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

const invalidLink = () => err({ code: "INVALID_LINK", message: INVALID_LINK_MESSAGE });
const internalFailure = (action: string, error: unknown) => {
  console.error(`[auth] ${action} failed`, error);
  return err({ code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** Thrown inside a transaction to roll it back (and put the token back) with a result to hand to the caller. */
class Refusal extends Error {
  constructor(readonly result: Result<never>) {
    super("refused");
  }
}

type Tx = Prisma.TransactionClient;

/** The tenant an audit entry belongs to: the one tenant every scope names, or none. */
function commonTenantId(scopes: readonly Scope[]): string | null {
  const ids = new Set(scopes.map((scope) => (scope.kind === "GLOBAL" ? null : scope.tenantId)));
  return ids.size === 1 && !ids.has(null) ? ([...ids][0] as string) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Makes an invitation: the invited e-mail, the roles the accepted account will hold, and a token (returned once, in the clear: the caller shows
 * the link to the administrator). `ttlHours` defaults to 7 days. Refuses a bad e-mail, an assignment that is not valid (a global role other than
 * ADMIN, an unknown role, an incomplete scope), a TTL outside 1 hour to 30 days, and a creator that does not exist, creating nothing.
 */
export async function createInvitation(input: {
  email: string;
  roles: readonly Assignment[];
  createdById: string;
  ttlHours?: number;
}): Promise<Result<{ invitationId: string; token: string; expiresAt: Date }>> {
  const checked = checkInvitation(input);
  if (!checked.success) return checked;
  try {
    return await prisma.$transaction((tx) => insertInvitation(tx, { ...checked.data, createdById: String(input.createdById) }));
  } catch (error) {
    return internalFailure("createInvitation", error);
  }
}

/** What an invitation is made of once its input has been checked: the normalized e-mail, the distinct valid assignments, the lifetime. */
export type CheckedInvitation = { email: string; assignments: Assignment[]; ttlHours: number };

/**
 * Checks the input of an invitation without touching the database: a bad e-mail, a TTL outside 1 hour to 30 days, too many roles and an assignment
 * that is not valid (a global role other than ADMIN, an unknown role, an incomplete scope) are refused; duplicates are folded. Shared by
 * `createInvitation` and the administration service that decides WHO may invite (`inviteUser`).
 */
export function checkInvitation(input: { email: string; roles: readonly Assignment[]; ttlHours?: number }): Result<CheckedInvitation> {
  const email = normalizeEmail(input.email);
  if (email === "" || email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return err({ code: "VALIDATION_ERROR", message: "Enter a valid e-mail address.", details: { field: "email" } });
  }
  const ttlHours = input.ttlHours ?? INVITATION_TTL_HOURS;
  if (typeof ttlHours !== "number" || !Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    return err({ code: "VALIDATION_ERROR", message: `An invitation lasts from 1 hour to ${MAX_TTL_HOURS / 24} days.`, details: { field: "ttlHours" } });
  }
  if (!Array.isArray(input.roles) || input.roles.length > MAX_ROLES_PER_INVITATION) {
    return err({ code: "VALIDATION_ERROR", message: `An invitation carries at most ${MAX_ROLES_PER_INVITATION} roles.`, details: { field: "roles" } });
  }
  const unique = new Map<string, Assignment>();
  for (const assignment of input.roles) {
    if (!assignment || !isValidAssignment(assignment.role, assignment.scope)) {
      return err({ code: "VALIDATION_ERROR", message: "One of the roles is not a valid assignment.", details: { field: "roles" } });
    }
    unique.set(`${assignment.role}\u0000${scopeKey(assignment.scope)}`, assignment);
  }
  return ok({ email, assignments: [...unique.values()], ttlHours });
}

/**
 * Writes the invitation and its audit entry inside the caller's transaction (so a service that decides in a SERIALIZABLE one can make the invitation
 * and what it replaces commit together). The creator must exist: the invitation is nobody's otherwise. Returns the token once, in the clear.
 */
export async function insertInvitation(
  tx: Tx,
  input: CheckedInvitation & { createdById: string }
): Promise<Result<{ invitationId: string; token: string; expiresAt: Date }>> {
  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlHours * HOUR_MS);
  const creator = await tx.user.findUnique({ where: { id: input.createdById }, select: { id: true } });
  if (!creator) return err({ code: "VALIDATION_ERROR", message: "The person creating the invitation does not exist." });
  const invitation = await tx.invitation.create({
    data: {
      emailLower: input.email,
      tokenHash,
      expiresAt,
      createdById: creator.id,
      roles: { create: input.assignments.map((a) => ({ role: a.role, scopeKey: scopeKey(a.scope) })) },
    },
    select: { id: true },
  });
  await tx.auditLog.create({
    data: {
      action: "INVITATION_CREATED",
      entityType: "Invitation",
      entityId: invitation.id,
      userId: creator.id,
      tenantId: commonTenantId(input.assignments.map((a) => a.scope)),
      // The invited address stays in `invitations`; the immutable log holds what was granted, not who.
      afterState: { roles: input.assignments.map((a) => ({ role: a.role, scopeKey: scopeKey(a.scope) })), expiresAt: expiresAt.toISOString() },
    },
  });
  return ok({ invitationId: invitation.id, token, expiresAt });
}

type LiveInvitation = { id: string; emailLower: string; createdById: string; roles: { role: string; scopeKey: string }[] };

/** The invitation this token opens, when it is live (known, unused, unexpired); null otherwise. */
async function liveInvitation(token: unknown, db: Pick<Tx, "invitation"> = prisma): Promise<LiveInvitation | null> {
  if (!isTokenShape(token)) return null;
  const row = await db.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, emailLower: true, createdById: true, usedAt: true, expiresAt: true, roles: { select: { role: true, scopeKey: true } } },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
  return { id: row.id, emailLower: row.emailLower, createdById: row.createdById, roles: row.roles };
}

/** For the invitation page: the e-mail the account will be bound to, when the link is live; null for every other state. */
export async function findValidInvitation(token: string): Promise<{ email: string } | null> {
  const invitation = await liveInvitation(token);
  return invitation ? { email: invitation.emailLower } : null;
}

/**
 * Completes a stored `(role, scopeKey)` into an assignment the policy accepts: the parents of a domain or product key come from the database
 * (the key names one id). null (skip) for a malformed key, a tenant, domain or product that no longer exists, an unknown role, or an assignment
 * that is not valid (a global role other than ADMIN).
 */
export async function completeAssignment(tx: Tx, row: { role: string; scopeKey: string }): Promise<Assignment | null> {
  if (!isRole(row.role)) return null;
  const parsed = parseScopeKey(row.scopeKey);
  if (!parsed) return null;
  let scope: Scope | null = null;
  switch (parsed.kind) {
    case "GLOBAL":
      scope = { kind: "GLOBAL" };
      break;
    case "TENANT": {
      const tenant = await tx.tenant.findUnique({ where: { id: parsed.tenantId }, select: { id: true } });
      scope = tenant ? { kind: "TENANT", tenantId: tenant.id } : null;
      break;
    }
    case "DOMAIN": {
      const domain = await tx.domain.findUnique({ where: { id: parsed.domainId }, select: { id: true, tenantId: true } });
      scope = domain ? { kind: "DOMAIN", tenantId: domain.tenantId, domainId: domain.id } : null;
      break;
    }
    case "PRODUCT": {
      const product = await tx.product.findUnique({ where: { id: parsed.productId }, select: { id: true, domainId: true, domain: { select: { tenantId: true } } } });
      scope = product ? { kind: "PRODUCT", tenantId: product.domain.tenantId, domainId: product.domainId, productId: product.id } : null;
      break;
    }
  }
  return scope && isValidAssignment(row.role, scope) ? { role: row.role as Role, scope } : null;
}

/** The `user_roles` columns for an assignment: the ids its scope names, null for the ones it does not (the table's CHECK keeps them consistent with the key). */
function roleColumns(scope: Scope) {
  return {
    scopeKey: scopeKey(scope),
    tenantId: scope.kind === "GLOBAL" ? null : scope.tenantId,
    domainId: scope.kind === "DOMAIN" || scope.kind === "PRODUCT" ? scope.domainId : null,
    productId: scope.kind === "PRODUCT" ? scope.productId : null,
  };
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed === "" ? null : trimmed;
}

/**
 * Accepts an invitation: makes the account (its e-mail is the INVITED one, never one the caller supplies), grants the invitation's role rows with
 * the invitation's creator as `grantedById`, spends the token and writes an audit entry, all in one transaction.
 *
 * Answers `INVALID_LINK` for a wrong, malformed, expired or used token (checked first: nothing about the password is said to someone whose link
 * is dead), `VALIDATION_ERROR` for a password the policy refuses and `ACCOUNT_EXISTS` when the e-mail already has an account (any letter case); the
 * last two leave the token unspent so it can be used again.
 */
export async function acceptInvitation(token: string, input: { name?: string | null; password: string }): Promise<Result<{ userId: string; email: string }>> {
  try {
    const invitation = await liveInvitation(token);
    if (!invitation) return invalidLink();
    const policy = validatePassword(input.password, { email: invitation.emailLower });
    if (!policy.ok) return err({ code: "VALIDATION_ERROR", message: policy.message, details: { field: "password" } });
    const passwordHash = await hashPassword(input.password);
    const name = cleanName(input.name);
    const tokenHash = hashToken(token);

    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Refusal(invalidLink());

      if (await tx.user.findUnique({ where: { email: invitation.emailLower }, select: { id: true } })) {
        throw new Refusal(err({ code: "ACCOUNT_EXISTS", message: "An account for this e-mail address already exists. Sign in instead." }));
      }
      const user = await tx.user.create({ data: { email: invitation.emailLower, name, password: passwordHash }, select: { id: true, email: true } });

      // The authority of whoever made the invitation is judged NOW, not when they made it (decision of Task 4, ruling d): an invitation is a promise
      // of roles the creator could grant, and a creator who has since been disabled, demoted or removed from a tenant can no longer promise them. Each
      // role they may still grant (`grantAllowed`, from their stored assignments) is given; the others are skipped and listed in the audit entry; an
      // invitation none of whose roles survives makes a roleless account. The e-mail address was the creator's to invite either way.
      const creator = await loadActorAssignments(tx, invitation.createdById);
      const granted: Assignment[] = [];
      const skipped: Array<{ role: string; scopeKey: string; reason: "scope-gone" | "creator-cannot-grant" }> = [];
      for (const row of invitation.roles) {
        const assignment = await completeAssignment(tx, row);
        if (!assignment) {
          skipped.push({ role: row.role, scopeKey: row.scopeKey, reason: "scope-gone" });
          continue;
        }
        if (!creator || !grantAllowed([...creator], assignment.role, assignment.scope)) {
          skipped.push({ role: row.role, scopeKey: row.scopeKey, reason: "creator-cannot-grant" });
          continue;
        }
        await tx.userRole.create({ data: { userId: user.id, role: assignment.role, ...roleColumns(assignment.scope), grantedById: invitation.createdById } });
        granted.push(assignment);
      }

      await tx.auditLog.create({
        data: {
          action: "INVITATION_ACCEPTED",
          entityType: "User",
          entityId: user.id,
          userId: user.id,
          // The tenant of what was granted, else (nothing was) of what was asked for.
          tenantId: commonTenantId(granted.map((a) => a.scope)),
          afterState: {
            invitationId: invitation.id,
            roles: granted.map((a) => ({ role: a.role, scopeKey: scopeKey(a.scope) })),
            ...(skipped.length > 0 ? { skipped } : {}),
          },
        },
      });
      return ok({ userId: user.id, email: user.email });
    });
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    // Another request made this e-mail's account between our look-up and our insert: the same answer as finding it.
    if (isUniqueViolation(error)) return err({ code: "ACCOUNT_EXISTS", message: "An account for this e-mail address already exists. Sign in instead." });
    return internalFailure("acceptInvitation", error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Makes a reset link token for a user (returned once, in the clear; valid for an hour). The link is handed to the person who needs it by
 * whoever issued it (there is no e-mail service): `issuedById` is who that was, for the audit entry (default the user). NOT_FOUND for no such user.
 * More than one token may be outstanding; using any of them kills the rest.
 */
export async function createResetToken(userId: string, options: { issuedById?: string } = {}): Promise<Result<{ token: string; expiresAt: Date }>> {
  if (typeof userId !== "string" || userId === "") return err({ code: "NOT_FOUND", message: "Not found" });
  try {
    const made = await prisma.$transaction((tx) => insertResetToken(tx, { userId, issuedById: options.issuedById ?? userId }));
    return made.success ? ok({ token: made.data.token, expiresAt: made.data.expiresAt }) : made;
  } catch (error) {
    return internalFailure("createResetToken", error);
  }
}

/**
 * Writes a reset token and its audit entry (`PASSWORD_RESET_ISSUED`, by `issuedById`, in `tenantId` when the issuer acts in one) inside the caller's
 * transaction, and with `revokeOthers` ends every earlier unused reset token of the user first (a new link replaces the old ones: only one is ever
 * live), answering how many LIVE ones that stopped. NOT_FOUND for no such user. The token is returned once, in the clear.
 */
export async function insertResetToken(
  tx: Tx,
  input: { userId: string; issuedById: string; tenantId?: string | null; revokeOthers?: boolean }
): Promise<Result<{ token: string; expiresAt: Date; invalidatedLinks: number }>> {
  const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (!user) return err({ code: "NOT_FOUND", message: "Not found" });
  const { token, tokenHash } = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_HOURS * HOUR_MS);
  let invalidatedLinks = 0;
  if (input.revokeOthers) {
    invalidatedLinks = await tx.authToken.count({ where: { userId: user.id, kind: "RESET", usedAt: null, expiresAt: { gt: now } } });
    await tx.authToken.updateMany({ where: { userId: user.id, kind: "RESET", usedAt: null }, data: { usedAt: now } });
  }
  await tx.authToken.create({ data: { userId: user.id, kind: "RESET", tokenHash, expiresAt } });
  await tx.auditLog.create({
    data: {
      action: "PASSWORD_RESET_ISSUED",
      entityType: "User",
      entityId: user.id,
      userId: input.issuedById,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      afterState: { expiresAt: expiresAt.toISOString(), ...(input.revokeOthers ? { invalidatedLinks } : {}) },
    },
  });
  return ok({ token, expiresAt, invalidatedLinks });
}

type LiveReset = { id: string; userId: string; email: string };

/** The reset token's user, when the link is live: known, of kind RESET, unused, unexpired, and the user exists and is not disabled. */
async function liveReset(token: unknown): Promise<LiveReset | null> {
  if (!isTokenShape(token)) return null;
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, kind: true, usedAt: true, expiresAt: true, user: { select: { id: true, email: true, disabledAt: true } } },
  });
  if (!row || row.kind !== "RESET" || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.user || row.user.disabledAt !== null) return null;
  return { id: row.id, userId: row.user.id, email: row.user.email };
}

/** For the reset page: `{ valid: true }` when the link is live, null otherwise. It names no user. */
export async function findValidResetToken(token: string): Promise<{ valid: true } | null> {
  return (await liveReset(token)) ? { valid: true } : null;
}

/**
 * Uses a reset token: sets the user's new password, spends the token and every other outstanding reset token of that user, and writes an audit
 * entry, all in one transaction. The same answers as `acceptInvitation`: `INVALID_LINK` for a dead link (a disabled user's link is dead), and
 * `VALIDATION_ERROR` for a password the policy refuses, which leaves the token unspent. Sessions already signed in stay valid until they expire
 * (the session is a signed token with no server-side record to revoke): docs/auth-ops.md.
 */
export async function consumeResetToken(token: string, password: string): Promise<Result<{ userId: string }>> {
  try {
    const live = await liveReset(token);
    if (!live) return invalidLink();
    const policy = validatePassword(password, { email: live.email });
    if (!policy.ok) return err({ code: "VALIDATION_ERROR", message: policy.message, details: { field: "password" } });
    const passwordHash = await hashPassword(password);
    const tokenHash = hashToken(token);

    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.authToken.updateMany({
        where: { id: live.id, tokenHash, kind: "RESET", usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new Refusal(invalidLink());

      const changed = await tx.user.updateMany({ where: { id: live.userId, disabledAt: null }, data: { password: passwordHash } });
      if (changed.count !== 1) throw new Refusal(invalidLink());
      await tx.authToken.updateMany({ where: { userId: live.userId, kind: "RESET", usedAt: null }, data: { usedAt: now } });
      await tx.auditLog.create({ data: { action: "PASSWORD_RESET", entityType: "User", entityId: live.userId, userId: live.userId } });
      return ok({ userId: live.userId });
    });
  } catch (error) {
    if (error instanceof Refusal) return error.result;
    return internalFailure("consumeResetToken", error);
  }
}
