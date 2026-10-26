import { InvalidLinkCard } from "../../_components/invalid-link";
import { findValidResetToken } from "@/lib/auth/tokens";
import { ResetPasswordForm } from "./reset-password-form";

// Whether a link is valid is a fact about the database right now: never rendered ahead of time, never cached.
export const dynamic = "force-dynamic";

/**
 * /reset/[token]: the form to choose a new password, for a link that is valid, unexpired and unused (and whose account is not disabled), and ONE
 * generic "this link is not valid or has expired" card for every other case: the page cannot tell a visitor which, and it never names the account.
 * Public in the middleware (the person has no session: that is why they are here).
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await findValidResetToken(token);
  if (!valid) return <InvalidLinkCard />;
  return <ResetPasswordForm token={token} />;
}
