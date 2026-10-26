import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { productionSecretProblem } from "@/lib/auth-secret";
import { DEFAULT_REGISTRATION_MODE, REGISTRATION_MODES } from "@/lib/auth/registration-mode";

/**
 * In production the session secret must be strong: the session cookie is signed with it. Development and test accept any non-empty value.
 * The same rule is enforced when the server starts (src/instrumentation.ts), because this schema is only checked where it is imported.
 */
function requireStrongSecretInProduction(value: string, ctx: z.RefinementCtx): void {
  if (process.env.NODE_ENV !== "production") return;
  const problem = productionSecretProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
}

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    // In production the secret must be strong (32+ characters, not a development value): see `requireStrongSecretInProduction`.
    NEXTAUTH_SECRET: z.string().min(1).superRefine(requireStrongSecretInProduction),
    NEXTAUTH_URL: z.string().url(),
    // Who may make an account: open, invite (the default) or closed. An empty value is unset. docs/auth-ops.md; the reader is src/lib/auth/registration-mode.ts.
    AUTH_REGISTRATION: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.enum(REGISTRATION_MODES).default(DEFAULT_REGISTRATION_MODE),
    ),
    // `1`: take the client address of sign-in throttling from X-Forwarded-For (a proxy in front sets it). Anything else: one shared bucket. src/lib/auth/throttle.ts.
    AUTH_TRUST_PROXY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    // Comma-separated e-mail domains a Google sign-in is limited to (access-control Task 8 reads it; declared here so the setting has one home).
    GOOGLE_ALLOWED_DOMAINS: z.string().optional(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    AUTH_REGISTRATION: process.env.AUTH_REGISTRATION,
    AUTH_TRUST_PROXY: process.env.AUTH_TRUST_PROXY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_ALLOWED_DOMAINS: process.env.GOOGLE_ALLOWED_DOMAINS,
  },
});
