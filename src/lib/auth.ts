import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { resolveAuthSecret } from "@/lib/auth-secret";
import { authenticateWithPassword } from "@/lib/auth/credentials";
import { googleSignInEnabled } from "@/lib/auth/providers";
import { clientIp } from "@/lib/auth/throttle";
import { resolveTrustHost } from "@/lib/auth/trust-host";

/** A session lives 12 hours from its last renewal and is renewed at most once an hour (access-control design, decision 8). */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

const providers = [
  Credentials({
    name: "credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    // The whole decision (normalized e-mail, the lock, a bcrypt compare that always runs, disabled accounts, the log) is `authenticateWithPassword`;
    // a refusal of any kind is `null`, and the login page says the same thing for all of them. The address comes from the request's headers, and only
    // from X-Forwarded-For when AUTH_TRUST_PROXY=1 (src/lib/auth/throttle.ts).
    async authorize(credentials, request) {
      return authenticateWithPassword({ email: credentials?.email, password: credentials?.password, ip: clientIp(request.headers) });
    },
  }),
  // The Google provider exists only when it is configured; its rules (verified e-mail, allowed domains, no automatic linking) are access-control Task 8.
  ...(googleSignInEnabled()
    ? [
        Google({
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        }),
      ]
    : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // The secret the middleware verifies the cookie with (src/lib/session-cookie.ts): one rule for both, an empty name is not set. Left
  // undefined when neither name is set, so Auth.js falls back to its own AUTH_SECRET_1..3 (which the middleware does not read: docs/auth-ops.md).
  secret: resolveAuthSecret(),
  // Written out, not left to Auth.js's default (docs/auth-ops.md, "Trusting the host"): src/lib/auth/trust-host.ts.
  trustHost: resolveTrustHost(),
  // The session is a signed JWT in a cookie (the middleware decrypts it with the same secret and salt: `getToken`, src/lib/session-cookie.ts). The
  // token carries its own expiry, so `maxAge` is how long a login lasts; a user disabled after signing in is refused by the principal loader on
  // the next request (src/lib/access/principal.ts), not by waiting for this to run out.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS, updateAge: SESSION_UPDATE_AGE_SECONDS },
  jwt: { maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers,
  callbacks: {
    /**
     * Runs for every provider after the credentials are accepted: a disabled user does not sign in, and a sign-in is recorded as `lastLoginAt`
     * (best effort: a problem writing it never blocks a sign-in). A user who is not in the database yet (the first Google sign-in) has no row to
     * be disabled or to update; the provider's own rules decide about them (Task 8). When the database cannot say whether the user is disabled,
     * this throws and the sign-in fails.
     */
    async signIn({ user }) {
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
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
      }
      if (user?.email) {
        token.email = user.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      // Propagate the e-mail for display only. The user is always resolved by session.user.id: there is no look-up by e-mail, so a stale id
      // (after a database reset + reseed) is nobody and signs in again (src/lib/access/principal.ts, src/lib/current-user.ts).
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email;
      }
      return session;
    },
  },
});
