/**
 * The decision for a sign-in through an identity provider (anything but the local credentials), access-control Task 8b. ONE pure function for every
 * provider: the registry (`src/lib/auth/providers.ts`) holds what differs between them as data (`ProviderPolicy`), and nothing here knows a provider's name.
 *
 * The rules, in the order they are checked (the first that fails is the reason; the user is told none of them: the callback answers the same refusal
 * as for a wrong password, `src/lib/auth/provider-callback.ts`):
 *
 *   1. provider-disabled   the provider is not in the configuration (`AUTH_PROVIDERS`);
 *   2. email-missing       the profile carries no usable e-mail address;
 *   3. email-unverified    the address is not verified. `email_verified === true` (the claim the descriptor names) unless the provider's descriptor says
 *                          its API can only return verified addresses (`verifiedEmailGuaranteed`) AND the claim is absent; a claim that is present and not
 *                          `true` is always a refusal. Where a provider does not say, the answer is no: an address the provider has not verified proves nothing;
 *   4. domain              when the provider has `_ALLOWED_DOMAINS`, the e-mail's domain must match, and so must the `hd`-style claim when the profile has one;
 *   5. no-account          the user must ALREADY EXIST (an administrator made the account or invited them): nobody signs up through a provider;
 *   6. disabled            a disabled user does not sign in;
 *   7. not-linked          a user who has not signed in through this provider before (no linked provider account) may only do so when the provider's
 *                          `linkExistingUsers` is on.
 *
 * Why linking by e-mail is off by default, and what turning it on means. Linking an existing local account to a provider account because both name the
 * same e-mail address makes the PROVIDER's claim about who owns the address the proof of identity. That is the standard trade-off of "sign in with ..."
 * (Auth.js calls the switch `allowDangerousEmailAccountLinking`): it is only as safe as the provider's e-mail verification. A provider that lets someone
 * claim an address it has not verified (or an administrator of a tenant who can set any address) would let them take over the local account of that
 * address, administrator accounts included. So it is a per-provider switch (`AUTH_PROVIDER_<KEY>_LINK_EXISTING_USERS=1`), and it is combined, always,
 * with rule 3: it never waives the verified-e-mail rule. Enable it only for identity providers whose verified e-mails the operator trusts (their own
 * single sign-on, a company-managed workspace), and restrict them with `_ALLOWED_DOMAINS`. A user who has linked the provider account once is recognised
 * by the provider's stable account id from then on (`linked`), and signs in without the switch.
 */

/** What the registry knows about one enabled provider that the decision needs. */
export type ProviderPolicy = {
  /** The Auth.js provider id. */
  readonly id: string;
  /** The provider's API can only ever return an e-mail the provider has verified (so a missing claim is acceptable). */
  readonly verifiedEmailGuaranteed: boolean;
  /** The claim that says the e-mail is verified (`email_verified`, or what the provider names it). */
  readonly verifiedEmailClaim: string;
  /** Lower-case domains (`example.com`) and suffixes with a leading dot (`.example.com`); empty means no restriction. */
  readonly allowedDomains: readonly string[];
  /** `_LINK_EXISTING_USERS=1`. */
  readonly linkExistingUsers: boolean;
};

/** What the database says about the account the profile belongs to: `null` for nobody. */
export type ExistingUser = {
  readonly disabled: boolean;
  /** The user has a linked account of THIS provider (the stable provider account id matched), so the e-mail is not what identifies them. */
  readonly linked: boolean;
} | null;

export type ProviderSignInRefusal = "provider-disabled" | "email-missing" | "email-unverified" | "domain" | "no-account" | "disabled" | "not-linked";
export type ProviderSignInDecision = { allow: true } | { allow: false; reason: ProviderSignInRefusal };

/** `local@domain`: one `@`, no space, something on both sides. A look at the shape, not the RFC (a quoted local part with an `@` is refused: fail closed). */
const USABLE_EMAIL = /^[^\s@]+@[^\s@]+$/;

/** A host name as it appears after the `@` of an address: labels of letters, digits and dashes joined by dots, at least two labels. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function domainMatches(domain: string, allowed: readonly string[]): boolean {
  if (!HOST.test(domain)) return false;
  return allowed.some((entry) => (entry.startsWith(".") ? domain.endsWith(entry) : domain === entry));
}

/**
 * Does the e-mail's domain match the list? Case-insensitive; `example.com` matches exactly that domain, `.example.com` matches every subdomain of it
 * (and not `example.com` itself, nor `badexample.com`). An address of unusable shape matches nothing.
 */
export function emailDomainAllowed(email: string, allowed: readonly string[]): boolean {
  if (!USABLE_EMAIL.test(email)) return false;
  return domainMatches(email.slice(email.indexOf("@") + 1).toLowerCase(), allowed);
}

export function evaluateProviderSignIn(input: {
  /** The Auth.js provider id the user signed in through. */
  provider: string;
  /** The provider's profile: the ID token claims for OpenID Connect providers, the user-info response for OAuth ones. */
  profile: Readonly<Record<string, unknown>> | null | undefined;
  config: { readonly enabled: readonly ProviderPolicy[] };
  existingUser: ExistingUser;
}): ProviderSignInDecision {
  const refuse = (reason: ProviderSignInRefusal): ProviderSignInDecision => ({ allow: false, reason });
  const { profile, existingUser } = input;

  const policy = input.config.enabled.find((candidate) => candidate.id === input.provider);
  if (!policy) return refuse("provider-disabled");

  const email = typeof profile?.email === "string" ? profile.email.trim() : "";
  if (!USABLE_EMAIL.test(email)) return refuse("email-missing");

  const claim = profile?.[policy.verifiedEmailClaim];
  const verified = claim === undefined ? policy.verifiedEmailGuaranteed : claim === true;
  if (!verified) return refuse("email-unverified");

  if (policy.allowedDomains.length > 0) {
    if (!emailDomainAllowed(email, policy.allowedDomains)) return refuse("domain");
    // The hosted-domain claim (`hd`), when the provider sends one, must agree: both pass.
    const hd = profile?.hd;
    if (hd !== undefined && hd !== null && (typeof hd !== "string" || !domainMatches(hd.toLowerCase(), policy.allowedDomains))) return refuse("domain");
  }

  if (existingUser === null) return refuse("no-account");
  if (existingUser.disabled) return refuse("disabled");
  if (!existingUser.linked && !policy.linkExistingUsers) return refuse("not-linked");
  return { allow: true };
}
