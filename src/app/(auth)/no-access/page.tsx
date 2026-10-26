import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignOutButton } from "./sign-out-button";

// Whether the user holds a role is decided by the dashboard on every request: this page is never a cached copy.
export const dynamic = "force-dynamic";

/**
 * "No access yet": where a signed-in user lands when they may access no tenant: no role assigned to them yet, or an account that has been disabled.
 * The page says the same thing for both, so it tells nobody which, and it names nothing else: no tenant, no administrator, no reason.
 *
 * It needs a session and no role: the middleware sends a visitor without a valid session to /login (this path is not one of its public pages) and lets
 * a signed-in user through (it only redirects a signed-in user away from /login, /register, /invite and /reset), so there is no redirect loop with the
 * dashboard layout, which sends a roleless user here. The e-mail shown is the session's own (display only).
 */
export default async function NoAccessPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const email = typeof session.user.email === "string" ? session.user.email : null;

  return (
    <div data-testid="no-access" className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <h1 className="text-display text-foreground">No access yet</h1>
      {email && (
        <p className="text-body-small text-muted-foreground mt-space-1" data-testid="no-access-email">
          Signed in as <span className="text-foreground font-medium">{email}</span>
        </p>
      )}
      <p className="text-body text-muted-foreground mt-space-4">
        Your account is signed in, but no role has been assigned to it yet, so there is nothing for you to open.
      </p>
      <p className="text-body text-muted-foreground mt-space-2">
        Ask an administrator of this workspace, or the person who invited you, to give you a role. Once they have, check again below.
      </p>
      <div className="mt-space-6 flex flex-wrap items-center gap-space-3">
        {/* The dashboard decides: a user who now holds a role is let in, one who does not is sent back here. */}
        <Link href="/schemas" className="text-body-small underline text-foreground">
          Check again
        </Link>
        <SignOutButton />
      </div>
    </div>
  );
}
