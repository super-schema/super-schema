/**
 * `registerAction` under the three registration modes (`AUTH_REGISTRATION`, access-control design decision 6):
 *   closed  refuses; invite  needs a live invitation token (else the generic dead-link answer); open  makes a ROLELESS account and answers
 *   EXACTLY the same, with the same redirect, whether the address is new or already has an account (no oracle, no second account, no sign-in).
 * The database side of the same promises (no role of any kind, one account for a case-variant address) is
 * tests/integration/auth/register-pglite.test.ts; here the database is replaced to see what the action asks of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    findUnique: vi.fn(),
    create: vi.fn(),
    userRoleCreate: vi.fn(),
    auditCreate: vi.fn(),
    transaction: vi.fn(),
    hashPassword: vi.fn(),
    requestIp: vi.fn(),
    reserveAttempt: vi.fn(),
    signIn: vi.fn(),
    acceptInvitationAction: vi.fn(),
    redirect: vi.fn((to: string) => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
    }),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique, create: mocks.create },
    userRole: { create: mocks.userRoleCreate },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/auth/password-hash", () => ({ hashPassword: mocks.hashPassword }));
vi.mock("@/lib/auth/request-guard", () => ({ requestIp: mocks.requestIp, reserveAttempt: mocks.reserveAttempt }));
vi.mock("@/lib/auth", () => ({ signIn: mocks.signIn }));
vi.mock("@/app/(auth)/invite/[token]/actions", () => ({ acceptInvitationAction: mocks.acceptInvitationAction }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
const waits = vi.hoisted(() => ({ waitFor: vi.fn<(ms: number) => Promise<void>>(async () => undefined) }));
vi.mock("@/lib/auth/login-backoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/login-backoff")>()),
  loginBackoffMs: () => 1500,
  waitFor: waits.waitFor,
}));

import { registerAction } from "@/app/(auth)/register/actions";
import { INVALID_LINK_MESSAGE, REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/messages";
import { UNTRUSTED_IP } from "@/lib/auth/client-ip";

const GOOD = "tangerine-lantern-orbit-42";
const IP = "203.0.113.7";

function registration(overrides: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ email: "First@Example.com", password: GOOD, confirmPassword: GOOD, ...overrides })) data.set(key, value);
  return data;
}

/** The redirect the action ended with, or the state it returned. */
async function outcome(data = registration()): Promise<{ state: unknown } | { redirectTo: string }> {
  try {
    return { state: await registerAction(undefined, data) };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}

const mode = (value: string | undefined) => vi.stubEnv("AUTH_REGISTRATION", value as string);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: "new-user" });
  mocks.hashPassword.mockResolvedValue("hashed-password");
  mocks.requestIp.mockResolvedValue(IP);
  mocks.reserveAttempt.mockResolvedValue(false);
  mocks.acceptInvitationAction.mockResolvedValue({ error: INVALID_LINK_MESSAGE, invalid: true });
});

describe("AUTH_REGISTRATION=closed", () => {
  it("refuses, and touches nothing: no throttle, no hash, no look-up, no account", async () => {
    mode("closed");
    expect(await outcome()).toEqual({ state: { error: REGISTRATION_CLOSED_MESSAGE } });
    expect(mocks.reserveAttempt).not.toHaveBeenCalled();
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.acceptInvitationAction).not.toHaveBeenCalled();
  });
});

describe("AUTH_REGISTRATION=invite (the default)", () => {
  it("is the mode when nothing is set", async () => {
    mode(undefined);
    expect(await outcome()).toEqual({ state: { error: INVALID_LINK_MESSAGE } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("without an invitation token: the generic dead-link answer, no account, and nothing says registration exists by invitation only", async () => {
    mode("invite");
    expect(await outcome()).toEqual({ state: { error: INVALID_LINK_MESSAGE } });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("with a token: the invitation's own action decides (it throttles, checks the token, and makes the account for the INVITED e-mail), whatever e-mail the form carries", async () => {
    mode("invite");
    mocks.acceptInvitationAction.mockResolvedValue({ fieldErrors: { password: "The password must be at least 12 bytes (it is 5)." } });

    const result = await outcome(registration({ inviteToken: "T".repeat(43), email: "someone-else@example.com" }));

    expect(result).toEqual({ state: { fieldErrors: { password: "The password must be at least 12 bytes (it is 5)." } } });
    const forwarded = mocks.acceptInvitationAction.mock.calls[0][1] as FormData;
    expect(forwarded.get("token")).toBe("T".repeat(43));
    expect(forwarded.get("password")).toBe(GOOD);
    expect(forwarded.get("confirmPassword")).toBe(GOOD);
    // The e-mail of the form goes nowhere: the account is for the address the invitation names.
    expect([...forwarded.keys()]).not.toContain("email");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("with a token that is dead: the same generic answer as without one", async () => {
    mode("invite");
    expect(await outcome(registration({ inviteToken: "T".repeat(43) }))).toEqual({ state: { error: INVALID_LINK_MESSAGE } });
  });
});

describe("AUTH_REGISTRATION=open", () => {
  beforeEach(() => mode("open"));

  it("makes a user with no role at all, hashing the password and normalizing the e-mail, and never signs anybody in", async () => {
    const result = await outcome(registration({ email: "  First@Example.COM " }));

    expect(result).toEqual({ redirectTo: "/login?notice=registered" });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "first@example.com" }, select: { id: true } });
    expect(mocks.hashPassword).toHaveBeenCalledWith(GOOD);
    expect(mocks.create).toHaveBeenCalledWith({ data: { email: "first@example.com", password: "hashed-password" }, select: { id: true } });
    // No role of any kind is written by registering, the first user of an empty database included: nobody becomes the administrator by registering first.
    expect(mocks.userRoleCreate).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("writes no audit entry: audit rows are immutable and point at their user, so one would make the account impossible to delete (the attempt is in auth_events)", async () => {
    await outcome();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("takes its place in the per-address throttle BEFORE any work (a success counts: an account is what is being limited)", async () => {
    mocks.reserveAttempt.mockImplementation(async () => {
      expect(mocks.hashPassword).not.toHaveBeenCalled();
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      return false;
    });
    await outcome();
    expect(mocks.reserveAttempt).toHaveBeenCalledWith("register", IP);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("a locked address is told so, with nothing created and no bcrypt run", async () => {
    mocks.reserveAttempt.mockResolvedValue(true);
    const result = await outcome();
    expect(result).toEqual({ state: { error: "Too many attempts. Try again in a few minutes." } });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("without a client address the shared lock is never asked: the sign-up waits (login-backoff) and is made, whatever the shared lock would say", async () => {
    mocks.requestIp.mockResolvedValue(UNTRUSTED_IP);
    mocks.reserveAttempt.mockResolvedValue(true);
    expect(await outcome()).toEqual({ redirectTo: "/login?notice=registered" });
    expect(mocks.reserveAttempt).not.toHaveBeenCalled();
    expect(waits.waitFor).toHaveBeenCalledWith(1500);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  describe("an e-mail that already has an account is answered EXACTLY like a new one", () => {
    it("the same redirect, the same work (a hash), no second account, no sign-in", async () => {
      const fresh = await outcome();
      const freshHashes = mocks.hashPassword.mock.calls.length;
      vi.clearAllMocks();
      mocks.hashPassword.mockResolvedValue("hashed-password");
      mocks.requestIp.mockResolvedValue(IP);
      mocks.reserveAttempt.mockResolvedValue(false);
      mocks.findUnique.mockResolvedValue({ id: "someone" });

      const existing = await outcome();

      expect(existing).toEqual(fresh);
      expect(existing).toEqual({ redirectTo: "/login?notice=registered" });
      expect(mocks.hashPassword.mock.calls.length).toBe(freshHashes);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.signIn).not.toHaveBeenCalled();
      // The attempt counts the same.
      expect(mocks.reserveAttempt).toHaveBeenCalledWith("register", IP);
    });

    it("also when the database refuses the duplicate that won the race (or differs only by letter case)", async () => {
      mocks.create.mockRejectedValue(Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002" }));
      expect(await outcome()).toEqual({ redirectTo: "/login?notice=registered" });
      mocks.create.mockRejectedValue(new Error("Unique constraint failed on the fields: (`email`)"));
      expect(await outcome()).toEqual({ redirectTo: "/login?notice=registered" });
    });
  });

  it("an unexpected database failure is a generic try-again, never the cause", async () => {
    mocks.create.mockRejectedValue(new Error("connection refused: postgres://user:secret@db"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await outcome();
    expect(result).toEqual({ state: { error: "Registration failed. Please try again." } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  describe("input the visitor can fix (answered without any look-up, so it says nothing about accounts)", () => {
    it.each([
      ["a bad e-mail", { email: "not an address" }, { email: "Enter a valid e-mail address." }],
      ["a confirmation that differs", { confirmPassword: `${GOOD}x` }, { confirmPassword: "Passwords do not match" }],
    ])("%s", async (_name, overrides, fieldErrors) => {
      expect(await outcome(registration(overrides))).toEqual({ state: { fieldErrors } });
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.hashPassword).not.toHaveBeenCalled();
      expect(mocks.reserveAttempt).not.toHaveBeenCalled();
    });

    it.each([
      ["a short password", "short1!", /at least 12 bytes/],
      ["a common password", "password1234", /too easy to guess/],
      ["a password that holds the e-mail's name", "first.person-2026!", /e-mail/],
    ])("%s: the policy's words at the password field", async (_name, password, message) => {
      const result = (await outcome(registration({ email: "first.person@example.com", password, confirmPassword: password }))) as { state: { fieldErrors: { password: string } } };
      expect(result.state.fieldErrors.password).toMatch(message);
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.hashPassword).not.toHaveBeenCalled();
    });
  });
});
