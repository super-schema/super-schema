import Link from "next/link";
import { REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/messages";

/** What /register shows when `AUTH_REGISTRATION=closed`: that registration is closed, and the way to sign in. No form. */
export function RegistrationClosedCard() {
  return (
    <div data-testid="registration-closed" className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <h1 className="text-display text-foreground">Registration is closed</h1>
      <p role="status" className="text-body text-muted-foreground mt-space-2">
        {REGISTRATION_CLOSED_MESSAGE}
      </p>
      <p className="text-body-small mt-space-6">
        Already have an account?{" "}
        <Link href="/login" className="underline text-foreground">
          Sign in
        </Link>
      </p>
    </div>
  );
}
