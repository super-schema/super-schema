"use server";

import { redirect } from "next/navigation";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";
import { isBlocked, recordQuietly, requestIp } from "@/lib/auth/request-guard";
import { consumeResetToken } from "@/lib/auth/tokens";
import type { TokenFormState } from "../../_components/token-form-state";

const TRY_AGAIN = "Something went wrong. Please try again.";
const text = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Sets a new password with a reset link. A public action, so it throttles per client address FIRST (a locked address gets the dead-link answer
 * and the token is not looked at); only a dead link counts toward the limit, not a password the policy refuses. Nobody is signed in by a reset:
 * the user goes to the login page and signs in with the new password.
 */
export async function consumeResetAction(_prev: TokenFormState | undefined, formData: FormData): Promise<TokenFormState | undefined> {
  const ip = await requestIp();
  if (await isBlocked("reset_consume", ip)) return { error: INVALID_LINK_MESSAGE, invalid: true };

  const password = text(formData, "password");
  if (password !== text(formData, "confirmPassword")) return { fieldErrors: { confirmPassword: "Passwords do not match" } };

  try {
    const result = await consumeResetToken(text(formData, "token"), password);
    if (!result.success) {
      switch (result.error.code) {
        case "INVALID_LINK":
          await recordQuietly("reset_consume", { ip, outcome: "failure" });
          return { error: INVALID_LINK_MESSAGE, invalid: true };
        case "VALIDATION_ERROR":
          await recordQuietly("reset_consume", { ip, outcome: "attempt" });
          return { fieldErrors: { password: result.error.message } };
        default:
          return { error: TRY_AGAIN };
      }
    }
    await recordQuietly("reset_consume", { ip, outcome: "success" });
  } catch (error) {
    console.error("[auth] consumeResetAction failed", error);
    return { error: TRY_AGAIN };
  }
  redirect("/login?notice=reset");
}
