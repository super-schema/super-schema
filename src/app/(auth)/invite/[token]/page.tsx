import { InvalidLinkCard } from "../../_components/invalid-link";
import { findValidInvitation } from "@/lib/auth/tokens";
import { AcceptInvitationForm } from "./accept-invitation-form";

// Whether a link is valid is a fact about the database right now: never rendered ahead of time, never cached.
export const dynamic = "force-dynamic";

/**
 * /invite/[token]: the form to accept an invitation, for a link that is valid, unexpired and unused, and ONE generic "this link is not valid or has
 * expired" card for every other case (no such token, malformed, expired, used): the page cannot tell a visitor which. The invited e-mail is shown and
 * cannot be changed (the account is bound to it). Public in the middleware (a visitor has no session yet).
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await findValidInvitation(token);
  if (!invitation) return <InvalidLinkCard />;
  return <AcceptInvitationForm token={token} email={invitation.email} />;
}
