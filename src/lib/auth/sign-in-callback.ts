/**
 * The Auth.js `signIn` callback of this app (src/lib/auth.ts): one place that says what happens after a provider has accepted a person.
 *
 *   - a sign-in through an IDENTITY PROVIDER (anything but `credentials`) is `authorizeProviderSignIn` (src/lib/auth/provider-callback.ts): the pure
 *     policy with the real profile and the database's answer, the generic refusal, the event, `lastLoginAt`. A missing `account` is not credentials:
 *     it is refused there (fail closed);
 *   - a CREDENTIALS sign-in has been decided already by `authenticateWithPassword` (the password, the lock, a disabled account); this repeats the
 *     disabled check at the database (the user id is a database id here) and records `lastLoginAt`, best effort. When the database cannot say whether
 *     the user is disabled this throws and the sign-in fails.
 */
import { prisma } from "@/lib/db";
import { authorizeProviderSignIn } from "@/lib/auth/provider-callback";

export async function authSignInCallback(args: {
  user?: { id?: string | null } | null;
  account?: { provider?: unknown; providerAccountId?: unknown } | null;
  profile?: unknown;
}): Promise<boolean> {
  const { user, account, profile } = args;
  if (account?.provider !== "credentials") return authorizeProviderSignIn({ account, profile });

  const id = user?.id;
  if (typeof id !== "string" || id === "") return true;
  const row = await prisma.user.findUnique({ where: { id }, select: { disabledAt: true } });
  if (row?.disabledAt) return false;
  try {
    await prisma.user.updateMany({ where: { id }, data: { lastLoginAt: new Date() } });
  } catch (error) {
    console.error("[auth] could not record lastLoginAt", error);
  }
  return true;
}
