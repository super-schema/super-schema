import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { resolveAuthSecret } from "@/lib/auth-secret";

const providers = [
  Credentials({
    name: "credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      if (!credentials?.email || !credentials?.password) return null;

      const user = await prisma.user.findUnique({
        where: { email: credentials.email as string },
      });

      if (!user?.password) return null;

      const isValid = await bcrypt.compare(
        credentials.password as string,
        user.password
      );

      if (!isValid) return null;

      return { id: user.id, email: user.email, name: user.name };
    },
  }),
  // Conditionally add Google provider when credentials are configured
  ...(process.env.GOOGLE_CLIENT_ID
    ? [
        Google({
          clientId: process.env.GOOGLE_CLIENT_ID,
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
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers,
  callbacks: {
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
      // Explicitly propagate email so resolveCurrentUserId email-fallback works
      // even when session.user.id is stale (e.g. after DB reset + reseed)
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email;
      }
      return session;
    },
  },
});

// Export provider availability flags for UI conditional rendering
export const authProviders = {
  google: !!process.env.GOOGLE_CLIENT_ID,
};
