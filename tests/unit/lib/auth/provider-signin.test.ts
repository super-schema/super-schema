/**
 * `evaluateProviderSignIn`: the one decision for a sign-in through ANY identity provider (access-control Task 8b). Pure: the profile the provider
 * sent, the provider's policy from the registry, and what the database says about the account. Every branch, as a table.
 *
 * The rules: the provider is enabled; the e-mail claim is present; it is verified (`email_verified === true`, or the provider's descriptor says its
 * API only ever returns verified e-mails and the claim is absent); the optional allowed domains match the e-mail's domain (and `hd` when the profile
 * has one); the user ALREADY EXISTS (nobody signs up through a provider) and is not disabled; a user who has not signed in through this provider
 * before needs the provider's `linkExistingUsers` flag.
 */
import { describe, expect, it } from "vitest";
import { emailDomainAllowed, evaluateProviderSignIn, type ProviderPolicy, type ProviderSignInRefusal } from "@/lib/auth/provider-signin";

const POLICY: ProviderPolicy = { id: "okta", verifiedEmailGuaranteed: false, verifiedEmailClaim: "email_verified", allowedDomains: [], linkExistingUsers: false };
const KNOWN = { disabled: false, linked: true };

type Input = Parameters<typeof evaluateProviderSignIn>[0];
function decide(overrides: Partial<Input> & { policy?: Partial<ProviderPolicy> } = {}) {
  const { policy, ...rest } = overrides;
  const base: Input = {
    provider: "okta",
    profile: { sub: "00u1", email: "ada@example.com", email_verified: true },
    config: { enabled: [{ ...POLICY, ...policy }] },
    existingUser: KNOWN,
  };
  return evaluateProviderSignIn({ ...base, ...rest });
}

const refused = (reason: ProviderSignInRefusal) => ({ allow: false, reason });

describe("the provider must be enabled", () => {
  it("allows an enabled provider whose user exists and has signed in through it before", () => {
    expect(decide()).toEqual({ allow: true });
  });

  it.each([
    ["not in the configuration at all", { provider: "github" }],
    ["credentials (it is no registry provider: it never reaches this decision)", { provider: "credentials" }],
    ["an empty list", { config: { enabled: [] } }],
    ["an id that only looks like an enabled one", { provider: "Okta" }],
    ["a prototype name", { provider: "constructor" }],
    ["no provider id", { provider: "" }],
  ] as const)("refuses %s: provider-disabled", (_name, input) => {
    expect(decide(input as Partial<Input>)).toEqual(refused("provider-disabled"));
  });

  it("looks the provider up by id among the enabled ones (the others' policies do not apply)", () => {
    const strict: ProviderPolicy = { ...POLICY, id: "keycloak", allowedDomains: ["other.test"] };
    expect(decide({ config: { enabled: [strict, POLICY] } })).toEqual({ allow: true });
    expect(decide({ provider: "keycloak", config: { enabled: [strict, POLICY] } })).toEqual(refused("domain"));
  });
});

describe("the e-mail claim must be present", () => {
  it.each([
    ["no profile", null],
    ["no claim", { sub: "1", email_verified: true }],
    ["an empty claim", { email: "", email_verified: true }],
    ["a blank claim", { email: "   ", email_verified: true }],
    ["a number", { email: 42, email_verified: true }],
    ["a list", { email: ["ada@example.com"], email_verified: true }],
    ["an object", { email: { value: "ada@example.com" }, email_verified: true }],
    ["no @", { email: "ada.example.com", email_verified: true }],
    ["nothing before the @", { email: "@example.com", email_verified: true }],
    ["nothing after the @", { email: "ada@", email_verified: true }],
    ["a space inside", { email: "ada lovelace@example.com", email_verified: true }],
    ["two addresses", { email: "ada@example.com bob@example.com", email_verified: true }],
    ["two @", { email: "ada@evil.test@example.com", email_verified: true }],
  ] as const)("refuses %s: email-missing", (_name, profile) => {
    expect(decide({ profile: profile as Input["profile"] })).toEqual(refused("email-missing"));
  });
});

describe("the e-mail must be verified", () => {
  it.each([
    ["missing", { email: "ada@example.com" }],
    ["false", { email: "ada@example.com", email_verified: false }],
    ["the string \"true\" (only the boolean counts)", { email: "ada@example.com", email_verified: "true" }],
    ["1", { email: "ada@example.com", email_verified: 1 }],
    ["null", { email: "ada@example.com", email_verified: null }],
  ] as const)("a provider that does not guarantee it: %s -> email-unverified", (_name, profile) => {
    expect(decide({ profile })).toEqual(refused("email-unverified"));
  });

  it("true is verified", () => {
    expect(decide({ profile: { email: "ada@example.com", email_verified: true } })).toEqual({ allow: true });
  });

  it("a provider whose descriptor guarantees verified e-mails accepts a MISSING claim, and still refuses a claim that says otherwise", () => {
    const guaranteed = { verifiedEmailGuaranteed: true };
    expect(decide({ policy: guaranteed, profile: { email: "ada@example.com" } })).toEqual({ allow: true });
    expect(decide({ policy: guaranteed, profile: { email: "ada@example.com", email_verified: true } })).toEqual({ allow: true });
    expect(decide({ policy: guaranteed, profile: { email: "ada@example.com", email_verified: false } })).toEqual(refused("email-unverified"));
    expect(decide({ policy: guaranteed, profile: { email: "ada@example.com", email_verified: "yes" } })).toEqual(refused("email-unverified"));
  });

  it("reads the claim the descriptor names (Microsoft Entra ID sends xms_edov, not email_verified)", () => {
    const entra = { verifiedEmailClaim: "xms_edov" };
    expect(decide({ policy: entra, profile: { email: "ada@example.com", xms_edov: true } })).toEqual({ allow: true });
    expect(decide({ policy: entra, profile: { email: "ada@example.com", email_verified: true } })).toEqual(refused("email-unverified"));
    expect(decide({ policy: entra, profile: { email: "ada@example.com", xms_edov: false } })).toEqual(refused("email-unverified"));
  });
});

describe("allowed e-mail domains", () => {
  const withDomains = (allowedDomains: string[], email: string, extra: Record<string, unknown> = {}) =>
    decide({ policy: { allowedDomains }, profile: { email, email_verified: true, ...extra } });

  it("no list means no restriction (the `hd` claim is not looked at either)", () => {
    expect(withDomains([], "ada@anything.test", { hd: "elsewhere.test" })).toEqual({ allow: true });
  });

  it.each([
    [["example.com"], "ada@example.com", true],
    [["example.com"], "ADA@EXAMPLE.COM", true],
    [["example.com"], "ada@Example.Com", true],
    [["example.com", "example.org"], "ada@example.org", true],
    [["example.com"], "ada@sub.example.com", false],
    [["example.com"], "ada@notexample.com", false],
    [["example.com"], "ada@example.com.evil.test", false],
    [["example.com"], "ada@example.co", false],
    [["example.com"], "ada@example.com.", false],
    [[".example.com"], "ada@eu.example.com", true],
    [[".example.com"], "ada@a.b.example.com", true],
    [[".example.com"], "ada@EU.Example.COM", true],
    [[".example.com"], "ada@example.com", false],
    [[".example.com"], "ada@badexample.com", false],
    [[".example.com"], "ada@eu.example.com.evil.test", false],
    [[".example.com", "example.com"], "ada@example.com", true],
    [[".example.com", "example.com"], "ada@eu.example.com", true],
  ] as const)("allowed %j, e-mail %s -> %s", (allowed, email, ok) => {
    expect(withDomains([...allowed], email)).toEqual(ok ? { allow: true } : refused("domain"));
  });

  it.each(["ada@evil.test@example.com", "ada@example.com@evil.test", "ada@exa mple.com"])("an address with a second @ or a space (%s) is no usable e-mail, whatever the list says", (email) => {
    expect(withDomains(["example.com"], email)).toEqual(refused("email-missing"));
  });

  it("the hd claim, when the profile has one, must match as well as the e-mail domain (both pass)", () => {
    expect(withDomains(["example.com"], "ada@example.com", { hd: "example.com" })).toEqual({ allow: true });
    expect(withDomains(["example.com"], "ada@example.com", { hd: "EXAMPLE.com" })).toEqual({ allow: true });
    expect(withDomains(["example.com"], "ada@example.com", { hd: "evil.test" })).toEqual(refused("domain"));
    expect(withDomains(["example.com", "evil.test"], "ada@example.com", { hd: "evil.test" })).toEqual({ allow: true });
    expect(withDomains([".example.com"], "ada@eu.example.com", { hd: "eu.example.com" })).toEqual({ allow: true });
    expect(withDomains([".example.com"], "ada@eu.example.com", { hd: "example.com" })).toEqual(refused("domain"));
  });

  it("a hd claim that is present and not a text is a refusal (fail closed), absent or null is no claim", () => {
    expect(withDomains(["example.com"], "ada@example.com", { hd: ["example.com"] })).toEqual(refused("domain"));
    expect(withDomains(["example.com"], "ada@example.com", { hd: 5 })).toEqual(refused("domain"));
    expect(withDomains(["example.com"], "ada@example.com", { hd: "" })).toEqual(refused("domain"));
    expect(withDomains(["example.com"], "ada@example.com", { hd: null })).toEqual({ allow: true });
    expect(withDomains(["example.com"], "ada@example.com", { hd: undefined })).toEqual({ allow: true });
  });

  it("the domain rule comes after the e-mail rules: an unverified address of an allowed domain is unverified, of another domain is unverified too", () => {
    expect(decide({ policy: { allowedDomains: ["example.com"] }, profile: { email: "ada@evil.test" } })).toEqual(refused("email-unverified"));
  });

  it("emailDomainAllowed is the matching rule alone", () => {
    expect(emailDomainAllowed("ada@example.com", ["example.com"])).toBe(true);
    expect(emailDomainAllowed("ada@x.example.com", [".example.com"])).toBe(true);
    expect(emailDomainAllowed("ada@example.com", [".example.com"])).toBe(false);
    expect(emailDomainAllowed("ada@example.com", [])).toBe(false);
    expect(emailDomainAllowed("not an address", ["example.com"])).toBe(false);
  });
});

describe("the user must already exist (no sign-up through a provider)", () => {
  it("refuses an e-mail nobody has an account for: no-account", () => {
    expect(decide({ existingUser: null })).toEqual(refused("no-account"));
  });

  it("refuses a disabled user, whether or not they have signed in through the provider before: disabled", () => {
    expect(decide({ existingUser: { disabled: true, linked: true } })).toEqual(refused("disabled"));
    expect(decide({ existingUser: { disabled: true, linked: false }, policy: { linkExistingUsers: true } })).toEqual(refused("disabled"));
  });

  it("an enabled provider with no account is refused even when linking is on (linking is for an account that exists, not a way to make one)", () => {
    expect(decide({ existingUser: null, policy: { linkExistingUsers: true } })).toEqual(refused("no-account"));
  });
});

describe("linking an existing local user to the provider", () => {
  const firstTime = { disabled: false, linked: false };

  it("is refused by default: not-linked (an existing account is not taken over by whoever the provider says owns the address)", () => {
    expect(decide({ existingUser: firstTime })).toEqual(refused("not-linked"));
  });

  it("is allowed when the provider's flag is on", () => {
    expect(decide({ existingUser: firstTime, policy: { linkExistingUsers: true } })).toEqual({ allow: true });
  });

  it("a user who has already linked this provider account signs in without the flag", () => {
    expect(decide({ existingUser: { disabled: false, linked: true }, policy: { linkExistingUsers: false } })).toEqual({ allow: true });
  });

  it("the flag never waives the verified e-mail rule or the domain rule (the point of linking by e-mail is that the provider vouches for the address)", () => {
    const on = { linkExistingUsers: true };
    expect(decide({ existingUser: firstTime, policy: on, profile: { email: "ada@example.com" } })).toEqual(refused("email-unverified"));
    expect(decide({ existingUser: firstTime, policy: on, profile: { email: "ada@example.com", email_verified: false } })).toEqual(refused("email-unverified"));
    expect(decide({ existingUser: firstTime, policy: { ...on, allowedDomains: ["other.test"] } })).toEqual(refused("domain"));
    expect(decide({ existingUser: firstTime, policy: on, profile: {} })).toEqual(refused("email-missing"));
  });
});

describe("the reasons come in a fixed order", () => {
  it("provider-disabled, email-missing, email-unverified, domain, no-account, disabled, not-linked", () => {
    const worst: Input = {
      provider: "okta",
      profile: { email: "ada@evil.test", email_verified: false },
      config: { enabled: [{ ...POLICY, allowedDomains: ["example.com"] }] },
      existingUser: { disabled: true, linked: false },
    };
    const steps: Array<[Partial<Input>, ProviderSignInRefusal]> = [
      [{ provider: "github" }, "provider-disabled"],
      [{ profile: {} }, "email-missing"],
      [{}, "email-unverified"],
      [{ profile: { email: "ada@evil.test", email_verified: true } }, "domain"],
      [{ profile: { email: "ada@example.com", email_verified: true }, existingUser: null }, "no-account"],
      [{ profile: { email: "ada@example.com", email_verified: true } }, "disabled"],
      [{ profile: { email: "ada@example.com", email_verified: true }, existingUser: { disabled: false, linked: false } }, "not-linked"],
    ];
    for (const [change, reason] of steps) expect(evaluateProviderSignIn({ ...worst, ...change }), reason).toEqual(refused(reason));
  });
});
