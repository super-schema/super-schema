import { providerButtons } from "@/lib/auth/providers";
import { registrationMode } from "@/lib/auth/registration-mode";
import { LoginForm } from "./login-form";
import { signInWithProvider } from "./provider-actions";

// What the page shows depends on the server's environment (which identity providers are enabled? may anyone register?): read when the request is served, never
// baked into a build made somewhere else.
export const dynamic = "force-dynamic";

/**
 * The sign-in page. The client form is `login-form.tsx`; this server part tells it what the deployment offers: one button for each enabled identity
 * provider (`AUTH_PROVIDERS`: none by default), the "Create one" link only when registration is open (`AUTH_REGISTRATION=open`).
 */
export default function LoginPage() {
  return <LoginForm providers={providerButtons()} signInWithProvider={signInWithProvider} registrationOpen={registrationMode() === "open"} />;
}
