/**
 * Which sign-in providers are configured, in one place: Auth.js's provider list (src/lib/auth.ts) and the login page's Google button (passed from
 * the server page, src/app/(auth)/login/page.tsx) read the same answer, so the button is never shown for a provider that is not there.
 *
 * The Google provider itself (verified e-mail, allowed domains, no automatic linking) is access-control Task 8; this is only the flag.
 */
export function googleSignInEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.GOOGLE_CLIENT_ID ?? "").trim() !== "";
}
