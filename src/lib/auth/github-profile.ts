/**
 * The GitHub profile the sign-in decision sees (`src/lib/auth/providers.ts`, the `github` row).
 *
 * Auth.js's own GitHub look-up takes the profile's public e-mail, and when there is none, `emails.find(e => e.primary) ?? emails[0]` of
 * `/user/emails`, without reading `verified`: an address that nobody has verified, or one that is not even the primary one, can become "the e-mail",
 * and the e-mail is what ties a provider account to a local account. This replaces it: the e-mail is the PRIMARY address of GitHub's own list, and
 * only when GitHub says `verified: true`; the profile then also says `email_verified: true`. Anything else gives no e-mail, which the sign-in
 * decision refuses (`email-missing`). That is what makes the descriptor's `verifiedEmailGuaranteed` true for GitHub.
 *
 * Needs the `user:email` scope (Auth.js's GitHub default). The requests go to GitHub's API only; nothing runs unless somebody signs in.
 */
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

type EmailEntry = { email?: unknown; primary?: unknown; verified?: unknown };

/** The `userinfo.request` of the GitHub provider: GitHub's `/user` profile with `email` and `email_verified` set only from the verified primary address. */
export async function githubVerifiedPrimaryEmailProfile(
  context: { tokens: { access_token?: string | undefined } },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const init = { headers: { Authorization: `Bearer ${context.tokens.access_token ?? ""}`, "User-Agent": "authjs", Accept: "application/vnd.github+json" } };
  const profile = (await (await fetchImpl(USER_URL, init)).json()) as Record<string, unknown>;
  // The public address of the profile is not the verified primary one: never kept.
  delete profile.email;
  const response = await fetchImpl(EMAILS_URL, init);
  if (!response.ok) return profile;
  const list: unknown = await response.json();
  if (!Array.isArray(list)) return profile;
  const primary = (list as unknown[]).find(
    (entry): entry is EmailEntry & { email: string } =>
      typeof entry === "object" && entry !== null && (entry as EmailEntry).primary === true && (entry as EmailEntry).verified === true && typeof (entry as EmailEntry).email === "string",
  );
  if (primary) {
    profile.email = primary.email;
    profile.email_verified = true;
  }
  return profile;
}
