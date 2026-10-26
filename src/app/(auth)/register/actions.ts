"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { INVALID_LINK_MESSAGE, REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/messages";
import { hashPassword } from "@/lib/auth/password-hash";
import { normalizeEmail, validatePassword } from "@/lib/auth/password-policy";
import { registrationMode } from "@/lib/auth/registration-mode";
import { requestIp, reserveAttempt } from "@/lib/auth/request-guard";
import { acceptInvitationAction } from "../invite/[token]/actions";

export type RegisterState = {
  error?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
    confirmPassword?: string;
  };
};

const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const emailSchema = z.string().max(254).email();

/** Who registers is decided by `AUTH_REGISTRATION` (src/lib/auth/registration-mode.ts). */
export async function registerAction(_prevState: RegisterState | undefined, formData: FormData): Promise<RegisterState | undefined> {
  const mode = registrationMode();
  if (mode === "closed") return { error: REGISTRATION_CLOSED_MESSAGE };
  if (mode === "invite") return registerWithInvitation(formData);
  return registerOpen(formData);
}

/**
 * `invite` mode: registering is accepting an invitation. /register carries nothing an account can be made from except a LIVE invitation token
 * (`inviteToken`); without one, or with a dead one, the answer is the generic dead-link message, which says nothing about why. The invitation's own
 * action does the rest (it throttles, makes the account for the INVITED address, grants the invitation's roles, signs it in): the e-mail field of
 * this form is not passed on, because the account is bound to the invited address and not to what is typed.
 */
async function registerWithInvitation(formData: FormData): Promise<RegisterState | undefined> {
  const token = text(formData, "inviteToken");
  if (token === "") return { error: INVALID_LINK_MESSAGE };
  const forwarded = new FormData();
  forwarded.set("token", token);
  forwarded.set("password", text(formData, "password"));
  forwarded.set("confirmPassword", text(formData, "confirmPassword"));
  const state = await acceptInvitationAction(undefined, forwarded);
  return state && { error: state.error, fieldErrors: state.fieldErrors };
}

/**
 * `open` mode: anyone may register, and the account holds NO role (the user lands on /no-access until an administrator assigns one). The answer is
 * the SAME whether the address is new or already has an account: the same redirect to the login page with the same notice, the same work (the password
 * is hashed either way), and no second account. Nobody is signed in by registering: signing the new user in is only possible for a new address, and
 * "signed in" against "not" would tell a visitor which addresses have accounts.
 */
async function registerOpen(formData: FormData): Promise<RegisterState | undefined> {
  const email = normalizeEmail(text(formData, "email"));
  const password = text(formData, "password");
  const confirmPassword = text(formData, "confirmPassword");

  // What the visitor can fix, answered before anything is looked up: it says nothing about accounts.
  if (!emailSchema.safeParse(email).success) return { fieldErrors: { email: "Enter a valid e-mail address." } };
  if (password !== confirmPassword) return { fieldErrors: { confirmPassword: "Passwords do not match" } };
  const policy = validatePassword(password, { email });
  if (!policy.ok) return { fieldErrors: { password: policy.message } };

  const ip = await requestIp();
  if (await reserveAttempt("register", ip)) return { error: "Too many attempts. Try again in a few minutes." };

  try {
    const passwordHash = await hashPassword(password);
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!existing) await createAccount(email, passwordHash);
  } catch (error) {
    console.error("[auth] registerAction failed", error);
    return { error: "Registration failed. Please try again." };
  }
  redirect("/login?notice=registered");
}

/**
 * Makes the account, with no role. Losing a race to another registration of the same address is not a failure: the answer is the same.
 *
 * No audit entry: audit rows are immutable and point at their user, so one written here would make the account impossible to delete for good, and
 * registering is not a change somebody made to somebody else (the access-control audit list is grants, invitations, resets, disabling). The attempt is in
 * `auth_events` (by hash) and the account's own `createdAt` says when it was made.
 */
async function createAccount(email: string, passwordHash: string): Promise<void> {
  try {
    await prisma.user.create({ data: { email, password: passwordHash }, select: { id: true } });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2002" || (error instanceof Error && error.message.includes("Unique constraint"))) return;
    throw error;
  }
}
