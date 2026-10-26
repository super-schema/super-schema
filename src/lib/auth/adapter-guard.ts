/**
 * The Auth.js database adapter with two things changed (access-control Task 8b). Nobody signs up through an identity provider: an account is made by an
 * administrator or by an invitation, never by a sign-in. The policy (`src/lib/auth/provider-signin.ts`, run by the `signIn` callback BEFORE Auth.js touches
 * the database) refuses an e-mail that has no account; this is the second lock, for what the policy cannot see:
 *
 *   - `createUser` refuses. Nothing in this app creates a user through the adapter (registration and invitations write their own rows), so the only
 *     caller is Auth.js's OAuth flow when it finds nobody for the e-mail. A refusal here ends that sign-in with an error, the login page says the
 *     generic failure, and no row exists.
 *   - `getUserByEmail` looks the address up NORMALIZED (trimmed, lower case: how every account is stored and how the policy looked it up). Auth.js
 *     passes the address exactly as the provider wrote it; `John@Corp.com` would find nobody in a table of lower-case addresses, and Auth.js would go on to
 *     `createUser` (or, with linking on, miss the very user the policy let through).
 *
 * Everything else is the adapter's own (`linkAccount`, `getUserByAccount`, ...).
 */
import type { Adapter } from "next-auth/adapters";
import { normalizeEmail } from "@/lib/auth/password-policy";

export class ProviderSignUpRefused extends Error {
  constructor() {
    super("No account is created by a sign-in: accounts are made by an administrator or by an invitation (src/lib/auth/adapter-guard.ts).");
    this.name = "ProviderSignUpRefused";
  }
}

export function guardAdapter(adapter: Adapter): Adapter {
  const getUserByEmail = adapter.getUserByEmail;
  return {
    ...adapter,
    createUser: async () => {
      throw new ProviderSignUpRefused();
    },
    ...(getUserByEmail ? { getUserByEmail: (email: string) => getUserByEmail.call(adapter, normalizeEmail(email)) } : {}),
  };
}
