/**
 * "No access yet": where a signed-in user lands when they may access no tenant (no role assigned to them yet, or their account is
 * disabled: the page says the same thing for both, so it tells nobody which). PLACEHOLDER: the sign-in task (access-control Task 4)
 * completes it (who to ask, a proper sign-out control).
 *
 * The page needs a session and no role: the middleware sends a visitor without a valid session to /login (this path is not one of its
 * public auth pages) and lets a signed-in user through (it only redirects a signed-in user away from /login and /register), so
 * there is no redirect loop with the dashboard layout, which sends a roleless user here.
 */
export default function NoAccessPage() {
  return (
    <div data-testid="no-access" className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <h1 className="text-display text-foreground">No access yet</h1>
      <p className="text-body text-muted-foreground mt-space-2">
        Your account is signed in, but no role has been assigned to it yet. Ask an administrator to give you access, then sign in again.
      </p>
      <p className="text-body-small mt-space-6">
        {/* Auth.js's own sign-out page (a GET shows its confirmation form; the sign-out itself is its POST): a full document navigation to an API route, not a page of this app. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/api/auth/signout" className="underline text-foreground">
          Sign out
        </a>
      </p>
    </div>
  );
}
