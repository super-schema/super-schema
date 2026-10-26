import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db";
import { resolveAuthSecret } from "@/lib/auth-secret";
import { guardAdapter } from "@/lib/auth/adapter-guard";
import { authenticateWithPassword } from "@/lib/auth/credentials";
import { enabledProviders } from "@/lib/auth/providers";
import { authSignInCallback } from "@/lib/auth/sign-in-callback";
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
  // Credentials is always first and always there. The identity providers an administrator configured (`AUTH_PROVIDERS`: src/lib/auth/providers.ts, the
  // one table) come after it; the default is none. A provider with a configuration problem is not in the list.
  ...enabledProviders().map((enabled) => enabled.provider),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  // The guarded adapter: no sign-in creates an account (`createUser` refuses) and the e-mail look-up is normalized (src/lib/auth/adapter-guard.ts).
  adapter: guardAdapter(PrismaAdapter(prisma)),
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
  // Both to the login page: a refusal (`AccessDenied`, from the `signIn` callback) and any other failure of an identity provider's flow land there, where
  // the words are the generic login failure whatever `?error=` says (the code is never shown). Auth.js's own error page would name the error.
  pages: { signIn: "/login", error: "/login" },
  providers,
  callbacks: {
    // Credentials: the disabled check and `lastLoginAt`. An identity provider: the policy with the real profile, the generic refusal, the event and the
    // throttle (src/lib/auth/provider-callback.ts). Auth.js calls this BEFORE it creates, links or updates anything.
    signIn: authSignInCallback,
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
