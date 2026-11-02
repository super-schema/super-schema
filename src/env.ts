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
    // `1`: take the client address of sign-in throttling from X-Forwarded-For (a proxy in front sets it). Anything else: no client address (the limits that count by address do not count it). src/lib/auth/client-ip.ts.
    AUTH_TRUST_PROXY: z.string().optional(),
    // The identity providers offered next to local accounts, a comma list of keys of the table in src/lib/auth/providers.ts (empty = none: local accounts only).
    // Each provider's own settings are AUTH_PROVIDER_<KEY>_<CLIENT_ID|CLIENT_SECRET|ISSUER|LABEL|ALLOWED_DOMAINS|LINK_EXISTING_USERS>: their names come from that table
    // (`providerEnvNames`), which also reads and checks them (they are not declared one by one here). docs/auth.md.
    AUTH_PROVIDERS: z.string().optional(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    AUTH_REGISTRATION: process.env.AUTH_REGISTRATION,
    AUTH_TRUST_PROXY: process.env.AUTH_TRUST_PROXY,
    AUTH_PROVIDERS: process.env.AUTH_PROVIDERS,
  },
});
