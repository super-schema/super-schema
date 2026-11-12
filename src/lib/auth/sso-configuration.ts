import { productionSecretProblem, resolveAuthSecret } from "@/lib/auth-secret";
import { resolveProviderRegistry } from "@/lib/auth/providers";

type Env = Readonly<Record<string, string | undefined>>;

/** Offline deployment check. Never imports the database, contacts an issuer, or returns a client secret. */
export function checkSsoConfiguration(env: Env = process.env) {
  const registry = resolveProviderRegistry(env);
  const problems = [...registry.problems];
  if (registry.enabled.length === 0) problems.push("AUTH_PROVIDERS must enable at least one fully configured provider for SSO.");

  let origin: string | undefined;
  try {
    const url = new URL(env.AUTH_URL?.trim() || env.NEXTAUTH_URL?.trim() || "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["/", "/api/auth"].includes(url.pathname)) throw new Error();
    if (url.protocol === "http:" && (env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error();
    origin = url.origin;
  } catch {
    problems.push("Set AUTH_URL (or NEXTAUTH_URL) to the public application origin, using HTTPS in production; HTTP is only allowed for loopback development.");
  }

  const secret = resolveAuthSecret(env);
  if (!secret || (env.NODE_ENV === "production" && productionSecretProblem(secret))) {
    problems.push("Set a strong AUTH_SECRET (or NEXTAUTH_SECRET); production requires at least 32 characters and rejects development placeholders.");
  }

  return {
    problems,
    providers: registry.enabled.map(({ id, label, policy }) => ({
      id, label,
      callbackUrl: origin ? `${origin}/api/auth/callback/${id}` : null,
      allowedDomains: policy.allowedDomains,
      linkExistingUsers: policy.linkExistingUsers,
    })),
  };
}
