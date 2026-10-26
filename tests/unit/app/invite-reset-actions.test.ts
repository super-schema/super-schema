/**
 * The two public server actions behind /invite/[token] and /reset/[token]: they throttle per client address BEFORE they look at the token, they
 * answer a dead link (wrong, expired, used, or refused because of the limit) with the one generic message, a weak password with the policy's words
 * (which does not count as a failure: nobody is guessing), and a success with a sign-in (invitation) or a redirect to the login page (reset).
 * The token logic itself is tests/integration/auth/tokens-pglite.test.ts; here the library is replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptInvitation: vi.fn(),
  consumeResetToken: vi.fn(),
  requestIp: vi.fn(),
  isBlocked: vi.fn(),
  recordQuietly: vi.fn(),
  signIn: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  }),
}));

vi.mock("@/lib/auth/tokens", () => ({ acceptInvitation: mocks.acceptInvitation, consumeResetToken: mocks.consumeResetToken }));
vi.mock("@/lib/auth/request-guard", () => ({ requestIp: mocks.requestIp, isBlocked: mocks.isBlocked, recordQuietly: mocks.recordQuietly }));
vi.mock("@/lib/auth", () => ({ signIn: mocks.signIn }));
// next-auth's entry point cannot be loaded outside Next (it imports `next/server` without an extension); the action needs its AuthError class only.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { acceptInvitationAction } from "@/app/(auth)/invite/[token]/actions";
import { consumeResetAction } from "@/app/(auth)/reset/[token]/actions";
import { INVALID_LINK_MESSAGE } from "@/lib/auth/messages";

const TOKEN = "T".repeat(43);
const GOOD = "tangerine-lantern-orbit-42";
const IP = "203.0.113.7";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const inviteForm = (overrides: Record<string, string> = {}) => form({ token: TOKEN, name: "Ivy", password: GOOD, confirmPassword: GOOD, ...overrides });
const resetForm = (overrides: Record<string, string> = {}) => form({ token: TOKEN, password: GOOD, confirmPassword: GOOD, ...overrides });

/** The redirect an action ended with (a redirect is a throw in Next), or null when it returned a state. */
async function outcome(run: () => Promise<unknown>): Promise<{ state: unknown } | { redirectTo: string }> {
  try {
    return { state: await run() };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestIp.mockResolvedValue(IP);
  mocks.isBlocked.mockResolvedValue(false);
  mocks.recordQuietly.mockResolvedValue(undefined);
  mocks.signIn.mockResolvedValue(undefined);
  mocks.acceptInvitation.mockResolvedValue({ success: true, data: { userId: "u1", email: "ivy@example.test" } });
  mocks.consumeResetToken.mockResolvedValue({ success: true, data: { userId: "u1" } });
});

describe("acceptInvitationAction", () => {
  const run = (data = inviteForm()) => outcome(() => acceptInvitationAction(undefined, data));

  it("asks the throttle about this address and this endpoint first; a locked address gets the dead-link answer and the token is never looked at", async () => {
    mocks.isBlocked.mockResolvedValue(true);
    expect(await run()).toEqual({ state: { error: INVALID_LINK_MESSAGE, invalid: true } });
    expect(mocks.isBlocked).toHaveBeenCalledWith("invite_accept", IP);
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("passes the token, name and password to the library, and signs the new account in", async () => {
    const result = await run();

    expect(mocks.acceptInvitation).toHaveBeenCalledWith(TOKEN, { name: "Ivy", password: GOOD });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("invite_accept", { ip: IP, outcome: "success" });
    expect(mocks.signIn).toHaveBeenCalledWith("credentials", { email: "ivy@example.test", password: GOOD, redirectTo: "/schemas" });
    // The sign-in ends in a redirect (Auth.js throws it); here the mock returned, so the action returns nothing.
    expect(result).toEqual({ state: undefined });
  });

  it("when the sign-in itself is refused (the account exists now), goes to the login page with a notice instead of an error", async () => {
    const { AuthError } = await import("next-auth");
    mocks.signIn.mockRejectedValue(new AuthError("refused"));
    expect(await run()).toEqual({ redirectTo: "/login?notice=invited" });
  });

  it("lets a redirect thrown by the sign-in through (that is how Auth.js navigates)", async () => {
    mocks.signIn.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: "/schemas" }));
    expect(await run()).toEqual({ redirectTo: "/schemas" });
  });

  it.each([
    ["a wrong, expired or used link", { success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } }],
  ])("%s: the generic message, and the failure is counted against the address", async (_name, result) => {
    mocks.acceptInvitation.mockResolvedValue(result);
    expect(await run()).toEqual({ state: { error: INVALID_LINK_MESSAGE, invalid: true } });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("invite_accept", { ip: IP, outcome: "failure" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("a password the policy refuses: its words at the password field, NOT counted as a failure (someone choosing a password is not guessing)", async () => {
    mocks.acceptInvitation.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "The password must be at least 12 bytes (it is 5).", details: { field: "password" } } });
    expect(await run(inviteForm({ password: "short", confirmPassword: "short" }))).toEqual({
      state: { fieldErrors: { password: "The password must be at least 12 bytes (it is 5)." } },
    });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("invite_accept", { ip: IP, outcome: "attempt" });
    expect(mocks.recordQuietly).not.toHaveBeenCalledWith("invite_accept", expect.objectContaining({ outcome: "failure" }));
  });

  it("an e-mail that already has an account: says so to the person holding the link, not counted", async () => {
    mocks.acceptInvitation.mockResolvedValue({ success: false, error: { code: "ACCOUNT_EXISTS", message: "An account for this e-mail address already exists. Sign in instead." } });
    expect(await run()).toEqual({ state: { error: "An account for this e-mail address already exists. Sign in instead." } });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("invite_accept", { ip: IP, outcome: "attempt" });
  });

  it("a confirmation that differs is refused at the confirmation field before the library is asked anything", async () => {
    expect(await run(inviteForm({ confirmPassword: `${GOOD}x` }))).toEqual({ state: { fieldErrors: { confirmPassword: "Passwords do not match" } } });
    expect(mocks.acceptInvitation).not.toHaveBeenCalled();
  });

  it("an unexpected failure is a generic try-again, never the cause", async () => {
    mocks.acceptInvitation.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    expect(await run()).toEqual({ state: { error: "Something went wrong. Please try again." } });
    mocks.acceptInvitation.mockRejectedValue(new Error("connection refused: postgres://user:secret@db"));
    expect(JSON.stringify(await run())).not.toContain("secret");
  });

  it("a form without a token (or with something that is not a string) is a dead link", async () => {
    const data = new FormData();
    data.set("password", GOOD);
    data.set("confirmPassword", GOOD);
    mocks.acceptInvitation.mockResolvedValue({ success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } });
    expect(await run(data)).toEqual({ state: { error: INVALID_LINK_MESSAGE, invalid: true } });
    expect(mocks.acceptInvitation).toHaveBeenCalledWith("", expect.anything());
  });

  it("never returns the password it was given", async () => {
    mocks.acceptInvitation.mockResolvedValue({ success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } });
    expect(JSON.stringify(await run())).not.toContain(GOOD);
  });
});

describe("consumeResetAction", () => {
  const run = (data = resetForm()) => outcome(() => consumeResetAction(undefined, data));

  it("asks the throttle first; a locked address gets the dead-link answer and the token is never looked at", async () => {
    mocks.isBlocked.mockResolvedValue(true);
    expect(await run()).toEqual({ state: { error: INVALID_LINK_MESSAGE, invalid: true } });
    expect(mocks.isBlocked).toHaveBeenCalledWith("reset_consume", IP);
    expect(mocks.consumeResetToken).not.toHaveBeenCalled();
  });

  it("success: the password is changed and the user goes to the login page (nobody is signed in by a reset)", async () => {
    expect(await run()).toEqual({ redirectTo: "/login?notice=reset" });
    expect(mocks.consumeResetToken).toHaveBeenCalledWith(TOKEN, GOOD);
    expect(mocks.recordQuietly).toHaveBeenCalledWith("reset_consume", { ip: IP, outcome: "success" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("a dead link: the generic message, counted against the address", async () => {
    mocks.consumeResetToken.mockResolvedValue({ success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } });
    expect(await run()).toEqual({ state: { error: INVALID_LINK_MESSAGE, invalid: true } });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("reset_consume", { ip: IP, outcome: "failure" });
  });

  it("a weak password: the policy's words, not counted", async () => {
    mocks.consumeResetToken.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "That password is too easy to guess.", details: { field: "password" } } });
    expect(await run()).toEqual({ state: { fieldErrors: { password: "That password is too easy to guess." } } });
    expect(mocks.recordQuietly).toHaveBeenCalledWith("reset_consume", { ip: IP, outcome: "attempt" });
  });

  it("a confirmation that differs is refused before the library is asked", async () => {
    expect(await run(resetForm({ confirmPassword: "nope" }))).toEqual({ state: { fieldErrors: { confirmPassword: "Passwords do not match" } } });
    expect(mocks.consumeResetToken).not.toHaveBeenCalled();
  });

  it("an unexpected failure is a generic try-again", async () => {
    mocks.consumeResetToken.mockResolvedValue({ success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
    expect(await run()).toEqual({ state: { error: "Something went wrong. Please try again." } });
  });
});
