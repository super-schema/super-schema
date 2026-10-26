import Link from "next/link";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";

/**
 * What /invite/[token] and /reset/[token] show when the link cannot be used: ONE card for every reason (no such token, malformed, expired, used,
 * a disabled account), with no part of the address in it, so the page cannot tell a visitor which reason it was.
 */
export function InvalidLinkCard() {
  return (
    <div data-testid="invalid-link" className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <h1 className="text-display text-foreground">Link not valid</h1>
      <p role="alert" className="text-body text-muted-foreground mt-space-2">
        {INVALID_LINK_MESSAGE}
      </p>
      <p className="text-body-small mt-space-6">
        Ask the person who sent it for a new one, or{" "}
        <Link href="/login" className="underline text-foreground">
          go to sign in
        </Link>
        .
      </p>
    </div>
  );
}
