/**
 * The one-time links the administration hands to a person (there is no e-mail service): `/invite/<token>` and `/reset/<token>` (the pages of
 * `src/app/(auth)`). `path` is always known; `url` is the absolute address when the server knows its public origin (`AUTH_URL`, or `NEXTAUTH_URL`,
 * the pair Auth.js reads in that order) and is `null` otherwise, so a page can join its own origin to `path` instead of guessing one here.
 * The token is the only secret in a link: it is never logged by this module and the origin is only ever read from configuration, never from a request.
 */

type Env = Record<string, string | undefined>;

export type LinkAddress = { path: string; url: string | null };

/** The public origin of the app from configuration (`http` or `https` only), or null. */
export function publicOrigin(env: Env = process.env): string | null {
  for (const name of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    const raw = (env[name] ?? "").trim();
    if (raw === "") continue;
    try {
      const url = new URL(raw);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // not a URL
    }
    // The first name that is SET decides (Auth.js reads `AUTH_URL ?? NEXTAUTH_URL` the same way): one that is not a web address is no origin.
    return null;
  }
  return null;
}

function linkTo(route: "invite" | "reset", token: string, env: Env): LinkAddress {
  // A token is base64url (A-Z a-z 0-9 - _): nothing to escape, but encode anyway so a malformed value can never change the path.
  const path = `/${route}/${encodeURIComponent(token)}`;
  const origin = publicOrigin(env);
  return { path, url: origin === null ? null : `${origin}${path}` };
}

export const inviteLink = (token: string, env: Env = process.env): LinkAddress => linkTo("invite", token, env);
export const resetLink = (token: string, env: Env = process.env): LinkAddress => linkTo("reset", token, env);
