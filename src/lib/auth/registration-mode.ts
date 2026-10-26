/**
 * Who may make an account: `AUTH_REGISTRATION=open|invite|closed` (access-control design, decision 6). Default `invite`.
 *
 *   open    anyone may register; the account holds NO role (the user lands on /no-access until an administrator assigns one). The e2e run and a
 *           laptop use it; a deployment on the internet should not.
 *   invite  an account is made by accepting an invitation (/invite/<token>), which carries the roles it grants. /register answers with the
 *           generic invalid-link page unless it is given a live invitation token.
 *   closed  nobody registers (the page says so and the action refuses). Accounts come from `npm run admin:create`, the seed, or an invitation made
 *           before the mode was closed and still live.
 *
 * Read from the environment WHEN ASKED (not at import), so a request sees the setting the process was started with and a test sees the one it set.
 * src/env.ts declares the same name with the same values; it is not imported by the app (its other names would make a zero-config PGlite start
 * fail), so this is the reader. An unknown value (a typo) is the default, never `open`, and is said once in the log.
 */
export const REGISTRATION_MODES = ["open", "invite", "closed"] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];
export const DEFAULT_REGISTRATION_MODE: RegistrationMode = "invite";

let warned = false;

export function registrationMode(env: Readonly<Record<string, string | undefined>> = process.env): RegistrationMode {
  const raw = (env.AUTH_REGISTRATION ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_REGISTRATION_MODE;
  if ((REGISTRATION_MODES as readonly string[]).includes(raw)) return raw as RegistrationMode;
  if (!warned) {
    warned = true;
    console.warn(`[auth] AUTH_REGISTRATION="${raw.slice(0, 40)}" is not one of ${REGISTRATION_MODES.join(", ")}; using "${DEFAULT_REGISTRATION_MODE}".`);
  }
  return DEFAULT_REGISTRATION_MODE;
}
