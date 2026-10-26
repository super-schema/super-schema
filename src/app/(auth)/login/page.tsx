import { googleSignInEnabled } from "@/lib/auth/providers";
import { registrationMode } from "@/lib/auth/registration-mode";
import { LoginForm } from "./login-form";

// What the page shows depends on the server's environment (is Google configured? may anyone register?): read when the request is served, never
// baked into a build made somewhere else.
export const dynamic = "force-dynamic";

/**
 * The sign-in page. The client form is `login-form.tsx`; this server part tells it what the deployment offers: the Google button only when
 * `GOOGLE_CLIENT_ID` is set, the "Create one" link only when registration is open (`AUTH_REGISTRATION=open`).
 */
export default function LoginPage() {
  return <LoginForm googleEnabled={googleSignInEnabled()} registrationOpen={registrationMode() === "open"} />;
}
