"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { enabledProviders } from "@/lib/auth/providers";
import { safeCallbackUrl } from "@/lib/safe-callback-url";

/** Where a refusal goes: the login page, whose words are the generic failure whatever the code says (the code is never shown). */
const REFUSED = "/login?error=AccessDenied";

/**
 * What a provider button starts: Auth.js's sign-in for that provider, which ends in a redirect (a throw) to the provider's own page. A public action
 * (the visitor has no session yet), so it trusts nothing it is given: the provider must be one the registry has ENABLED (`AUTH_PROVIDERS`; Auth.js
 * would refuse an unknown id too, this refuses first and with the generic answer), and the destination after signing in is a path of this site
 * (`safeCallbackUrl`; the address of the login page is attacker-controlled). Nothing is decided about the person here: who may sign in is the `signIn`
 * callback, after the provider has answered (src/lib/auth/provider-callback.ts).
 *
 * @param providerId the Auth.js provider id of the button
 * @param callbackUrl where to go afterwards (the login page's `callbackUrl`)
 */
export async function signInWithProvider(providerId: string, callbackUrl: string): Promise<void> {
  const enabled = typeof providerId === "string" && enabledProviders().some((provider) => provider.id === providerId);
  if (!enabled) redirect(REFUSED);
  try {
    await signIn(providerId, { redirectTo: safeCallbackUrl(callbackUrl) });
  } catch (error) {
    // Auth.js's own failure (a provider that cannot start) is the generic failure on the login page; its redirect (a throw too) passes through.
    if (error instanceof AuthError) redirect(REFUSED);
    throw error;
  }
}
