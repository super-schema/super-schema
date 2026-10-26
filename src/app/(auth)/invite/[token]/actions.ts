"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";
import { isBlocked, recordQuietly, requestIp } from "@/lib/auth/request-guard";
import { acceptInvitation } from "@/lib/auth/tokens";
import type { TokenFormState } from "../../_components/token-form-state";

const TRY_AGAIN = "Something went wrong. Please try again.";
const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Accepts an invitation: makes the account for the invited e-mail (the form cannot change it: it is not read from the form), with the roles the
 * invitation carries, and signs the new account in. A public action (the visitor has no session yet), so it throttles per client address FIRST,
 * before it looks at the token: a locked address gets the dead-link answer and nothing about the token is looked up.
 *
 * What counts toward the limit is a dead link (a wrong guess); a password the policy refuses, or an e-mail that already has an account, is
 * someone choosing a password and is recorded without counting.
 */
export async function acceptInvitationAction(_prev: TokenFormState | undefined, formData: FormData): Promise<TokenFormState | undefined> {
  const ip = await requestIp();
  if (await isBlocked("invite_accept", ip)) return { error: INVALID_LINK_MESSAGE, invalid: true };

  const password = text(formData, "password");
  if (password !== text(formData, "confirmPassword")) return { fieldErrors: { confirmPassword: "Passwords do not match" } };

  let email: string;
  try {
    const result = await acceptInvitation(text(formData, "token"), { name: text(formData, "name"), password });
    if (!result.success) {
      switch (result.error.code) {
        case "INVALID_LINK":
          await recordQuietly("invite_accept", { ip, outcome: "failure" });
          return { error: INVALID_LINK_MESSAGE, invalid: true };
        case "VALIDATION_ERROR":
          await recordQuietly("invite_accept", { ip, outcome: "attempt" });
          return { fieldErrors: { password: result.error.message } };
        case "ACCOUNT_EXISTS":
          await recordQuietly("invite_accept", { ip, outcome: "attempt" });
          return { error: result.error.message };
        default:
          return { error: TRY_AGAIN };
      }
    }
    await recordQuietly("invite_accept", { ip, outcome: "success" });
    email = result.data.email;
  } catch (error) {
    console.error("[auth] acceptInvitationAction failed", error);
    return { error: TRY_AGAIN };
  }

  // The account exists now: sign it in. Auth.js ends this with a redirect (a throw); a sign-in it refuses (a lock, say) is not an error for the
  // person who just made the account, they go to the login page.
  try {
    await signIn("credentials", { email, password, redirectTo: "/schemas" });
  } catch (error) {
    if (error instanceof AuthError) redirect("/login?notice=invited");
    throw error;
  }
}
