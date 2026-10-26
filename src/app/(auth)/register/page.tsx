import { redirect } from "next/navigation";
import { googleSignInEnabled } from "@/lib/auth/providers";
import { registrationMode } from "@/lib/auth/registration-mode";
import { findValidInvitation } from "@/lib/auth/tokens";
import { InvalidLinkCard } from "../_components/invalid-link";
import { RegistrationClosedCard } from "../_components/registration-closed";
import { RegisterForm } from "./register-form";

// The mode, the Google flag and whether a token is live are facts about the server right now: never rendered ahead of time.
export const dynamic = "force-dynamic";

/**
 * /register under the three modes (`AUTH_REGISTRATION`, src/lib/auth/registration-mode.ts):
 *   closed  "registration is closed", no form;
 *   invite  needs a LIVE invitation token in the address (`/register?token=...`), which continues at /invite/<token>; without one, or with a dead
 *           one, the generic "this link is not valid or has expired" page (the same card for every reason);
 *   open    the registration form (the account holds no role).
 */
export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const mode = registrationMode();
  if (mode === "closed") return <RegistrationClosedCard />;
  if (mode === "invite") {
    const { token } = await searchParams;
    const asked = typeof token === "string" ? token : "";
    if (asked !== "" && (await findValidInvitation(asked))) redirect(`/invite/${encodeURIComponent(asked)}`);
    return <InvalidLinkCard />;
  }
  return <RegisterForm googleEnabled={googleSignInEnabled()} />;
}
