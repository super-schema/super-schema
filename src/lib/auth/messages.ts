/**
 * The words the sign-in surface answers with. One module, no imports, safe in a client component: the point of each constant is that it is the
 * SAME text for every reason a visitor could be refused, so the text cannot tell them which reason it was (no account enumeration, no lock oracle).
 */

/** Sign-in failed: an unknown e-mail, a wrong password, a disabled account, a locked e-mail or address, all of them. */
export const INVALID_CREDENTIALS_MESSAGE = "Invalid email or password";

/** A link (invitation or password reset) that is wrong, expired, used, malformed, or refused because of the limit: all of them. */
export const INVALID_LINK_MESSAGE = "This link is not valid or has expired.";

/** Registration is switched off (`AUTH_REGISTRATION=closed`). */
export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed. Ask an administrator for an invitation.";

/**
 * What `/register` answers (in `open` mode) to a well-formed request, whether the address is new or already has an account: the same words
 * either way, and the same redirect. It says both things that could be true.
 */
export const REGISTRATION_RECEIVED_MESSAGE =
  "Thanks. If this address was not registered before, your account is ready: sign in with the password you chose. If it already had an account, that account's own password applies.";

/** The notices the login page can show after a redirect (`/login?notice=<key>`): a fixed list, so nothing in the address is ever reflected. */
export const LOGIN_NOTICES = {
  registered: REGISTRATION_RECEIVED_MESSAGE,
  reset: "Your password was changed. Sign in with the new one.",
  invited: "Your account is ready. Sign in to continue.",
} as const;

export type LoginNoticeKey = keyof typeof LOGIN_NOTICES;

export function isLoginNoticeKey(value: unknown): value is LoginNoticeKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LOGIN_NOTICES, value);
}
