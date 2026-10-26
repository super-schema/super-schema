/**
 * The Auth.js `signIn` callback for an identity provider (src/lib/auth/provider-callback.ts), with a stubbed database: it asks the pure decision
 * (`evaluateProviderSignIn`) with the REAL profile and what the database says (a linked provider account first, else the user with the normalized
 * e-mail), answers `false` for every refusal (one answer: the login page says the same words as for a wrong password), writes an `auth_events` row
 * for a refusal (kind `provider_refused:<reason>`, outcome `refused`, only the e-mail and address hashes ever reach the table) and `lastLoginAt`
 * for a success, and is throttled per client address. Nothing here can create a user: the stub has no `create` at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPolicy } from "@/lib/auth/provider-signin";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { authorizeProviderSignIn, type ProviderCallbackDeps } from "@/lib/auth/provider-callback";

const POLICY: ProviderPolicy = { id: "keycloak", verifiedEmailGuaranteed: false, verifiedEmailClaim: "email_verified", allowedDomains: [], linkExistingUsers: false };
const ADA = { id: "user-ada", disabledAt: null as Date | null };

function setup(options: { policy?: Partial<ProviderPolicy>; accountUser?: typeof ADA | null; emailUser?: typeof ADA | null; throttled?: boolean } = {}) {
  const calls = {
    accountFind: vi.fn<(args: unknown) => Promise<{ user: typeof ADA } | null>>(async () => (options.accountUser ? { user: options.accountUser } : null)),
    userFind: vi.fn<(args: unknown) => Promise<typeof ADA | null>>(async () => options.emailUser ?? null),
    updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
    record: vi.fn<(kind: string, event: unknown) => Promise<void>>(async () => undefined),
    throttle: vi.fn<(input: unknown) => Promise<{ throttled: boolean }>>(async () => ({ throttled: options.throttled ?? false })),
  };
  const deps: ProviderCallbackDeps = {
    prisma: { account: { findUnique: calls.accountFind }, user: { findUnique: calls.userFind, updateMany: calls.updateMany } } as unknown as ProviderCallbackDeps["prisma"],
    providers: () => [{ ...POLICY, ...options.policy }],
    clientIp: async () => "203.0.113.7",
    isThrottled: calls.throttle as unknown as ProviderCallbackDeps["isThrottled"],
    recordAuthEvent: calls.record as unknown as ProviderCallbackDeps["recordAuthEvent"],
  };
  return { deps, calls };
}

const PROFILE = { sub: "kc-1", email: "ada@example.com", email_verified: true };
const ACCOUNT = { provider: "keycloak", providerAccountId: "kc-1" };
const run = (deps: ProviderCallbackDeps, input: { account?: unknown; profile?: unknown } = {}) =>
  authorizeProviderSignIn({ account: ("account" in input ? input.account : ACCOUNT) as never, profile: "profile" in input ? input.profile : PROFILE }, deps);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a sign-in the policy allows", () => {
  it("lets in a user who has linked this provider account: looked up by the provider's account id, lastLoginAt written, the success recorded by hash", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    expect(await run(deps)).toBe(true);
    expect(calls.accountFind).toHaveBeenCalledWith({ where: { provider_providerAccountId: { provider: "keycloak", providerAccountId: "kc-1" } }, select: { user: { select: { id: true, disabledAt: true } } } });
    expect(calls.userFind).not.toHaveBeenCalled();
    expect(calls.updateMany).toHaveBeenCalledWith({ where: { id: "user-ada" }, data: { lastLoginAt: expect.any(Date) } });
    expect(calls.record).toHaveBeenCalledWith("provider_login", { email: "ada@example.com", ip: "203.0.113.7", outcome: "success" });
  });

  it("lets in an existing local user the first time only when the provider's flag allows linking, found by the NORMALIZED e-mail", async () => {
    const { deps, calls } = setup({ policy: { linkExistingUsers: true }, emailUser: ADA });
    expect(await run(deps, { profile: { ...PROFILE, email: "  Ada@Example.COM " } })).toBe(true);
    expect(calls.userFind).toHaveBeenCalledWith({ where: { email: "ada@example.com" }, select: { id: true, disabledAt: true } });
    expect(calls.updateMany).toHaveBeenCalledWith({ where: { id: "user-ada" }, data: { lastLoginAt: expect.any(Date) } });
  });

  it("decides on the user the provider account is linked to, not on the user the e-mail now names (Auth.js signs in the linked one)", async () => {
    const other = { id: "user-other", disabledAt: new Date() };
    const { deps, calls } = setup({ accountUser: ADA, emailUser: other });
    expect(await run(deps)).toBe(true);
    expect(calls.userFind).not.toHaveBeenCalled();
    expect(calls.updateMany).toHaveBeenCalledWith({ where: { id: "user-ada" }, data: expect.anything() });
  });

  it("never blocks a sign-in because lastLoginAt or the success event could not be written", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    calls.updateMany.mockRejectedValue(new Error("busy"));
    calls.record.mockRejectedValue(new Error("busy"));
    expect(await run(deps)).toBe(true);
  });
});

describe("every refusal answers the same false, writes one refused event with the reason in its kind, and writes no lastLoginAt", () => {
  const cases: Array<[string, Parameters<typeof setup>[0], { account?: unknown; profile?: unknown }, string]> = [
    ["an e-mail nobody has an account for", { emailUser: null }, {}, "no-account"],
    ["a provider that is not enabled", {}, { account: { provider: "github", providerAccountId: "9" } }, "provider-disabled"],
    ["no account object at all", {}, { account: null }, "provider-disabled"],
    ["a profile without an e-mail", {}, { profile: { sub: "kc-1" } }, "email-missing"],
    ["an unverified e-mail", {}, { profile: { sub: "kc-1", email: "ada@example.com", email_verified: false } }, "email-unverified"],
    ["an e-mail outside the allowed domains", { policy: { allowedDomains: ["corp.test"] }, emailUser: ADA }, {}, "domain"],
    ["a disabled user (linked account)", { accountUser: { id: "u", disabledAt: new Date() } }, {}, "disabled"],
    ["a disabled user (found by e-mail, flag on)", { policy: { linkExistingUsers: true }, emailUser: { id: "u", disabledAt: new Date() } }, {}, "disabled"],
    ["an existing local user who never used this provider, flag off", { emailUser: ADA }, {}, "not-linked"],
    ["no profile at all", {}, { profile: null }, "email-missing"],
  ];

  it.each(cases)("%s -> false, provider_refused:%s", async (_name, options, input, reason) => {
    const { deps, calls } = setup(options);
    expect(await run(deps, input)).toBe(false);
    expect(calls.updateMany).not.toHaveBeenCalled();
    const refused = calls.record.mock.calls.filter(([kind]) => String(kind).startsWith("provider_refused:"));
    expect(refused).toHaveLength(1);
    expect(refused[0][0]).toBe(`provider_refused:${reason}`);
    expect(refused[0][1]).toMatchObject({ ip: "203.0.113.7", outcome: "refused" });
  });

  it("the event carries the NORMALIZED e-mail when there is a usable one (the recorder stores only its hash) and none otherwise", async () => {
    const a = setup({ emailUser: null });
    await run(a.deps, { profile: { email: " Nobody@Example.COM ", email_verified: true } });
    expect(a.calls.record).toHaveBeenCalledWith("provider_refused:no-account", { email: "nobody@example.com", ip: "203.0.113.7", outcome: "refused" });
    const b = setup();
    await run(b.deps, { profile: { sub: "x" } });
    expect(b.calls.record).toHaveBeenCalledWith("provider_refused:email-missing", { ip: "203.0.113.7", outcome: "refused" });
  });

  it("does not look anything up for a provider that is not enabled or a profile without an e-mail (nothing to learn from the database)", async () => {
    const { deps, calls } = setup({ emailUser: ADA });
    await run(deps, { account: { provider: "github", providerAccountId: "9" } });
    await run(deps, { profile: {} });
    expect(calls.accountFind).not.toHaveBeenCalled();
    expect(calls.userFind).not.toHaveBeenCalled();
  });

  it("a refusal is still a refusal when the event cannot be written", async () => {
    const { deps, calls } = setup({ emailUser: null });
    calls.record.mockRejectedValue(new Error("database is down"));
    expect(await run(deps)).toBe(false);
  });

  it("the stubbed database has nothing to create a user with: refusing never needs one", async () => {
    const { deps } = setup({ emailUser: null });
    expect(Object.keys(deps.prisma.user)).not.toContain("create");
    expect(Object.keys(deps.prisma.user)).not.toContain("upsert");
    expect(await run(deps)).toBe(false);
  });
});

describe("throttling by client address", () => {
  it("asks about the provider_refused family for the request's address", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    await run(deps);
    expect(calls.throttle).toHaveBeenCalledWith({ ip: "203.0.113.7", kind: "provider_refused" });
  });

  it("a locked address is refused before anything is looked up, with a locked event that does not count", async () => {
    const { deps, calls } = setup({ accountUser: ADA, throttled: true });
    expect(await run(deps)).toBe(false);
    expect(calls.accountFind).not.toHaveBeenCalled();
    expect(calls.userFind).not.toHaveBeenCalled();
    expect(calls.updateMany).not.toHaveBeenCalled();
    expect(calls.record).toHaveBeenCalledTimes(1);
    expect(calls.record).toHaveBeenCalledWith("provider_refused:throttled", expect.objectContaining({ ip: "203.0.113.7", outcome: "locked" }));
  });

  it("fails CLOSED: a throttle that cannot be read refuses the sign-in", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    calls.throttle.mockRejectedValue(new Error("database is down"));
    expect(await run(deps)).toBe(false);
    expect(calls.updateMany).not.toHaveBeenCalled();
  });

  it("uses the constant shared bucket when the request has no readable address", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    deps.clientIp = async () => {
      throw new Error("no request in scope");
    };
    expect(await run(deps)).toBe(true);
    expect(calls.throttle).toHaveBeenCalledWith({ ip: "untrusted", kind: "provider_refused" });
  });
});

describe("a database that cannot answer refuses (it never lets through)", () => {
  it("a failed look-up is a refusal, logged", async () => {
    const { deps, calls } = setup({ accountUser: ADA });
    calls.accountFind.mockRejectedValue(new Error("database is down"));
    expect(await run(deps)).toBe(false);
    expect(calls.updateMany).not.toHaveBeenCalled();
    // it is not a policy refusal ("no account"): the log does not say something that was never established
    expect(calls.record).not.toHaveBeenCalled();
  });
});
