/**
 * The first platform administrator (access-control design, decision 7).
 *
 * There is no "the first user to register becomes the administrator" and no administrator made as a side effect of a read: the only ways
 * to get a global ADMIN are `ensureBootstrapAdmin` below, called from `prisma/seed.ts` and `scripts/admin-create.mjs` (never from a
 * request path: a test scans `src/` for importers), and an existing administrator granting the role in the app.
 *
 * Plain Prisma client in, no `@/lib/db` import: the seed and the script own their own connection.
 */

import { compare, hash } from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import { scopeKey } from "@/lib/access/scope";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES, validatePassword } from "@/lib/auth/password-policy";

type AdminBootstrapClient = Pick<Prisma.TransactionClient, "user" | "userRole">;

/** The bounds of the one password rule (src/lib/auth/password-policy.ts), under the names this module has always exported. */
export const BOOTSTRAP_PASSWORD_MIN_BYTES = PASSWORD_MIN_BYTES;
export const BOOTSTRAP_PASSWORD_MAX_BYTES = PASSWORD_MAX_BYTES;
const BCRYPT_COST = 12;
const MAX_EMAIL_LENGTH = 254;

/** What a stored e-mail looks like: trimmed and lower-cased (the unique index is on lower(email)). */
export function normalizeBootstrapEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The password rule of the bootstrap paths: the one every account gets (12 to 72 bytes and the deny-list of trivial passwords, the address of
 * the administrator included when it is given). The development default (`admin`) is deliberately outside it and never passes through here.
 */
export function validateBootstrapPassword(password: string, email?: string): { ok: true } | { ok: false; message: string } {
  return validatePassword(password, { email });
}

/** The development administrator of a seeded database: what the e2e suite and a local `npm run db:seed` sign in with. Never created in production. */
export const DEV_DEFAULT_ADMIN = Object.freeze({ email: "admin@admin.com", password: "admin" });

export type SeedAdminPlan =
  /** `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` are set (any environment): create this administrator. */
  | { kind: "configured"; email: string; password: string }
  /** Nothing configured and not production: the development default. */
  | { kind: "development-default"; email: string; password: string }
  /** Nothing configured in production: no administrator is created (use `npm run admin:create`). */
  | { kind: "none" }
  /** The configuration cannot be used: the seed stops with `message`. */
  | { kind: "invalid"; message: string };

/**
 * Which administrator the seed makes (decision 7): the one named by `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` when both are
 * set (an empty value counts as unset; the password must satisfy `validateBootstrapPassword`), otherwise `admin@admin.com` / `admin`
 * ONLY when `NODE_ENV` is not "production", otherwise none. Half a configuration is an error, not a silent fallback.
 */
export function planSeedAdmin(env: Readonly<Record<string, string | undefined>>): SeedAdminPlan {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? "";
  const password = env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

  if (email !== "" || password !== "") {
    if (email === "" || password === "") {
      return { kind: "invalid", message: "BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together (one of them is missing or empty)." };
    }
    const policy = validateBootstrapPassword(password, email);
    if (!policy.ok) return { kind: "invalid", message: `BOOTSTRAP_ADMIN_PASSWORD is not acceptable. ${policy.message}` };
    return { kind: "configured", email, password };
  }
  if (env.NODE_ENV !== "production") return { kind: "development-default", ...DEV_DEFAULT_ADMIN };
  return { kind: "none" };
}

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(email);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code === "P2002") return true;
  return error instanceof Error && error.message.includes("Unique constraint");
}

export type BootstrapAdminResult =
  /** A new user was created with a global ADMIN assignment. */
  | { status: "created"; userId: string }
  /** The user existed (and proved the bootstrap password) and was given the global ADMIN assignment. */
  | { status: "granted"; userId: string }
  /** The user already held the global ADMIN assignment; nothing was changed. */
  | { status: "unchanged"; userId: string }
  /** Nothing was changed. `message` says why, for an operator. */
  | { status: "refused"; reason: "invalid-email" | "password-mismatch" | "conflict"; message: string };

const GLOBAL = scopeKey({ kind: "GLOBAL" });

async function hasGlobalAdmin(db: AdminBootstrapClient, userId: string): Promise<boolean> {
  const row = await db.userRole.findFirst({ where: { userId, role: "ADMIN", scopeKey: GLOBAL }, select: { id: true } });
  return row !== null;
}

/** Gives the user the global ADMIN assignment; a concurrent grant (the unique key) counts as done. */
async function grantGlobalAdmin(db: AdminBootstrapClient, userId: string): Promise<void> {
  try {
    await db.userRole.create({ data: { userId, role: "ADMIN", scopeKey: GLOBAL } });
  } catch (error) {
    if (!isUniqueViolation(error) || !(await hasGlobalAdmin(db, userId))) throw error;
  }
}

/**
 * Makes sure `email` is a user who holds the global ADMIN assignment. Idempotent, and never a way to take over an account:
 *   - no such user: creates it with `password` (bcrypt, cost 12) and the assignment;
 *   - the user exists and is already a global administrator: nothing changes (the password is not compared, not reset);
 *   - the user exists but is not an administrator: the assignment is added ONLY when `password` is that user's own password. Anyone who
 *     could register the operator's e-mail address before the first seed would otherwise become the administrator. A mismatch is a
 *     `refused` result, nothing is changed.
 * The password policy is the caller's (`validateBootstrapPassword`): the development default `admin` has to get through here.
 * Run only from `prisma/seed.ts` and `scripts/admin-create.mjs`.
 */
export async function ensureBootstrapAdmin(
  input: { email: string; password: string },
  db: AdminBootstrapClient,
): Promise<BootstrapAdminResult> {
  const email = normalizeBootstrapEmail(input.email);
  if (!isValidEmail(email)) {
    return { status: "refused", reason: "invalid-email", message: `"${email}" is not a usable e-mail address.` };
  }

  const existing = await db.user.findFirst({ where: { email }, select: { id: true, password: true } });
  if (existing) return ensureForExistingUser(db, existing, input.password);

  const passwordHash = await hash(input.password, BCRYPT_COST);
  let created: { id: string };
  try {
    created = await db.user.create({ data: { email, name: "Admin", password: passwordHash }, select: { id: true } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Someone else created it between the look-up and the insert (or it exists in a different letter case: the unique index is on lower(email)).
    const winner = await db.user.findFirst({ where: { email }, select: { id: true, password: true } });
    if (!winner) {
      return { status: "refused", reason: "conflict", message: `An account for "${email}" exists in a different letter case; resolve it by hand.` };
    }
    return ensureForExistingUser(db, winner, input.password);
  }
  await grantGlobalAdmin(db, created.id);
  return { status: "created", userId: created.id };
}

async function ensureForExistingUser(
  db: AdminBootstrapClient,
  user: { id: string; password: string | null },
  password: string,
): Promise<BootstrapAdminResult> {
  if (await hasGlobalAdmin(db, user.id)) return { status: "unchanged", userId: user.id };
  if (!user.password || !(await compare(password, user.password))) {
    return {
      status: "refused",
      reason: "password-mismatch",
      message: "An account with this e-mail already exists with a different password, so it was not made an administrator.",
    };
  }
  await grantGlobalAdmin(db, user.id);
  return { status: "granted", userId: user.id };
}
