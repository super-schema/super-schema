/**
 * The sign-in providers, in ONE typed table (access-control Task 8b). Local accounts (the credentials provider, `src/lib/auth.ts`) are always the
 * way in; an administrator can ADD identity providers that Auth.js already knows, by naming them in `AUTH_PROVIDERS` (a comma list) and giving each
 * its settings. The default is the empty list: no provider, no button, nothing for a typo to switch on.
 *
 * Who reads this: Auth.js's `providers` array (`src/lib/auth.ts`: `enabledProviders`), the login page's buttons (`providerButtons`), the sign-in
 * decision (`src/lib/auth/provider-signin.ts` takes the `policy` of the provider that is signing in) and the startup check
 * (`src/instrumentation.ts`: `refuseToStartWithBadProviderConfiguration`). The table below is the only place that knows the providers by name: a
 * provider is a row, never a branch of code.
 *
 * Settings, per provider key (the key is the Auth.js provider id, so the redirect URI is `{AUTH_URL}/api/auth/callback/<key>`):
 *   AUTH_PROVIDER_<KEY>_CLIENT_ID, _CLIENT_SECRET   required
 *   AUTH_PROVIDER_<KEY>_ISSUER                      required where the provider is OpenID Connect with an issuer of the operator's (okta, keycloak,
 *                                                   microsoft-entra-id, oidc); an absolute http(s) URL, https in production
 *   AUTH_PROVIDER_<KEY>_LABEL                       the button text; defaults to the provider's name; REQUIRED for the generic `oidc`
 *   AUTH_PROVIDER_<KEY>_ALLOWED_DOMAINS             optional comma list of e-mail domains that may sign in (src/lib/auth/provider-signin.ts)
 *   AUTH_PROVIDER_<KEY>_LINK_EXISTING_USERS         `1` lets a user who exists but has not used this provider yet sign in through it (default off)
 * where <KEY> is the key upper-cased with `-` as `_` (`microsoft-entra-id` -> `MICROSOFT_ENTRA_ID`).
 *
 * A configuration mistake is NEVER silent and never switches something on:
 *   - the provider that has a problem (an unknown name in the list, a missing or malformed setting) is not enabled;
 *   - a name `AUTH_PROVIDER_*` that no provider has (a typo such as `..._ALLOWD_DOMAINS`, which would silently drop the domain rule) disables ALL
 *     providers, because a mistyped key cannot be attributed to the provider it was meant for;
 *   - development and test log each problem once and carry on (a dev server must not crash over a provider); production refuses to start
 *     (`refuseToStartWithBadProviderConfiguration`, from `src/instrumentation.ts`, the pattern of the secret check in `src/lib/auth-secret.ts`).
 * Resolving never throws (`next build` imports the modules that call it, with none of the settings present).
 *
 * Nothing here contacts an identity provider: building a provider object is configuration only (OpenID discovery happens when somebody signs in).
 */
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Keycloak from "next-auth/providers/keycloak";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Okta from "next-auth/providers/okta";
import { githubVerifiedPrimaryEmailProfile } from "@/lib/auth/github-profile";
import type { ProviderPolicy } from "@/lib/auth/provider-signin";

type Env = Readonly<Record<string, string | undefined>>;

/** Everything a factory needs, already validated (`factory` is only called for a complete configuration). */
export type ProviderFactorySettings = {
  clientId: string;
  clientSecret: string;
  /** Present for the providers that need one. */
  issuer: string | undefined;
  label: string;
  /** `allowDangerousEmailAccountLinking` of Auth.js: true ONLY when the operator set `_LINK_EXISTING_USERS=1` (and the sign-in policy still wants a verified e-mail). */
  linkExistingUsers: boolean;
};

export type ProviderDescriptor = {
  /** The Auth.js provider id (and so the callback path and the name of the settings). */
  readonly key: string;
  /** The default button text. */
  readonly name: string;
  readonly needsIssuer: boolean;
  /** The generic provider has no name of its own: the operator must give one. */
  readonly needsLabel: boolean;
  /** True only when the provider's profile can only ever carry an e-mail that the provider has verified, so a missing `email_verified` is no reason to refuse. */
  readonly verifiedEmailGuaranteed: boolean;
  /** The claim that says the e-mail is verified (`email_verified` unless the provider names it otherwise). */
  readonly verifiedEmailClaim: string;
  readonly factory: (settings: ProviderFactorySettings) => Provider;
};

const linking = (s: ProviderFactorySettings) => ({ allowDangerousEmailAccountLinking: s.linkExistingUsers });

/**
 * The table. Order is the order of the keys in documentation and in the unit tests. `verifiedEmailGuaranteed` is true only for GitHub, and only
 * because `githubVerifiedPrimaryEmailProfile` replaces Auth.js's own e-mail look-up (which takes a public or unverified e-mail too) with the
 * primary address GitHub itself says is verified. Microsoft Entra ID does not send `email_verified`; its optional claim `xms_edov` (the e-mail's
 * domain owner is verified) must be enabled in the app registration, and without it every sign-in is refused (fail closed).
 */
export const PROVIDER_DESCRIPTORS = {
  google: {
    key: "google",
    name: "Google",
    needsIssuer: false,
    needsLabel: false,
    verifiedEmailGuaranteed: false,
    verifiedEmailClaim: "email_verified",
    factory: (s) => Google({ clientId: s.clientId, clientSecret: s.clientSecret, name: s.label, ...linking(s) }),
  },
  github: {
    key: "github",
    name: "GitHub",
    needsIssuer: false,
    needsLabel: false,
    verifiedEmailGuaranteed: true,
    verifiedEmailClaim: "email_verified",
    factory: (s) =>
      GitHub({ clientId: s.clientId, clientSecret: s.clientSecret, name: s.label, userinfo: { url: "https://api.github.com/user", request: githubVerifiedPrimaryEmailProfile }, ...linking(s) }),
  },
  "microsoft-entra-id": {
    key: "microsoft-entra-id",
    name: "Microsoft Entra ID",
    needsIssuer: true,
    needsLabel: false,
    verifiedEmailGuaranteed: false,
    verifiedEmailClaim: "xms_edov",
    factory: (s) => MicrosoftEntraID({ clientId: s.clientId, clientSecret: s.clientSecret, issuer: s.issuer, name: s.label, ...linking(s) }),
  },
  okta: {
    key: "okta",
    name: "Okta",
    needsIssuer: true,
    needsLabel: false,
    verifiedEmailGuaranteed: false,
    verifiedEmailClaim: "email_verified",
    factory: (s) => Okta({ clientId: s.clientId, clientSecret: s.clientSecret, issuer: s.issuer, name: s.label, ...linking(s) }),
  },
  keycloak: {
    key: "keycloak",
    name: "Keycloak",
    needsIssuer: true,
    needsLabel: false,
    verifiedEmailGuaranteed: false,
    verifiedEmailClaim: "email_verified",
    factory: (s) => Keycloak({ clientId: s.clientId, clientSecret: s.clientSecret, issuer: s.issuer, name: s.label, ...linking(s) }),
  },
  oidc: {
    key: "oidc",
    name: "OpenID Connect",
    needsIssuer: true,
    needsLabel: true,
    verifiedEmailGuaranteed: false,
    verifiedEmailClaim: "email_verified",
    factory: (s) => ({
      id: "oidc",
      name: s.label,
      type: "oidc",
      issuer: s.issuer,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      ...linking(s),
    }),
  },
} as const satisfies Record<string, ProviderDescriptor>;

export type ProviderKey = keyof typeof PROVIDER_DESCRIPTORS;
export const PROVIDER_KEYS = Object.keys(PROVIDER_DESCRIPTORS) as ProviderKey[];

const SETTINGS = ["CLIENT_ID", "CLIENT_SECRET", "ISSUER", "ALLOWED_DOMAINS", "LINK_EXISTING_USERS", "LABEL"] as const;
export type ProviderSetting = (typeof SETTINGS)[number];

/** `providerEnvName("microsoft-entra-id", "CLIENT_ID")` is `AUTH_PROVIDER_MICROSOFT_ENTRA_ID_CLIENT_ID`. */
export function providerEnvName(key: string, setting: ProviderSetting): string {
  return `AUTH_PROVIDER_${key.toUpperCase().replace(/-/g, "_")}_${setting}`;
}

/** Every setting name of every provider (the issuer only for the providers that have one): what the environment groups of the release runner must account for. */
export function providerEnvNames(): string[] {
  return PROVIDER_KEYS.flatMap((key) => SETTINGS.filter((setting) => setting !== "ISSUER" || PROVIDER_DESCRIPTORS[key].needsIssuer).map((setting) => providerEnvName(key, setting)));
}

export type EnabledProvider = {
  /** The Auth.js provider id. */
  readonly id: string;
  /** The button text. */
  readonly label: string;
  /** What the sign-in decision needs to know about this provider. */
  readonly policy: ProviderPolicy;
  /** The Auth.js provider object for the `providers` array. */
  readonly provider: Provider;
};

export type ProviderRegistry = { enabled: readonly EnabledProvider[]; problems: readonly string[] };

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** One entry of `_ALLOWED_DOMAINS`: a domain (`example.com`) or a suffix with a leading dot (`.example.com`), letters, digits, dashes and dots only. */
const DOMAIN_ENTRY = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function parseDomains(raw: string | undefined, name: string, problems: string[]): string[] {
  if (raw === undefined) return [];
  const entries = [...new Set(raw.split(",").map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))];
  const bad = entries.filter((entry) => !DOMAIN_ENTRY.test(entry));
  if (entries.length === 0) {
    problems.push(`${name} is set but lists no domain: an empty list would mean "no restriction". Unset it for that, or list the domains (example.com, or .example.com for every subdomain).`);
  }
  for (const entry of bad) {
    problems.push(`${name} has the entry "${entry}", which can never match: use a domain (example.com) or a suffix with a leading dot (.example.com), nothing else (no @, no *, no scheme).`);
  }
  return entries.length === 0 || bad.length > 0 ? [] : entries;
}

function issuerProblem(raw: string, env: Env): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must be an http(s) URL";
  if (env.NODE_ENV === "production" && url.protocol !== "https:") return "must be an https URL in production";
  return null;
}

/** Parses AUTH_PROVIDERS: lower-cased, trimmed, no empty entries, no repeats, order kept. */
function listedNames(env: Env): string[] {
  const raw = env.AUTH_PROVIDERS ?? "";
  return [...new Set(raw.split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== ""))];
}

/**
 * The configuration, judged: the providers that are enabled and every problem found. Pure (no logging, no throwing). A provider with a problem is
 * absent from `enabled`; an unknown `AUTH_PROVIDER_*` name empties `enabled` (see the header).
 *
 * @param env the environment to read (the process's by default)
 */
export function resolveProviderRegistry(env: Env = process.env): ProviderRegistry {
  const problems: string[] = [];
  const enabled: EnabledProvider[] = [];
  const known = new Set(providerEnvNames());

  const unknownSettings = Object.keys(env)
    .filter((name) => name.startsWith("AUTH_PROVIDER_") && !known.has(name) && value(env, name) !== undefined)
    .sort();
  for (const name of unknownSettings) {
    problems.push(
      `${name} is not a setting of any sign-in provider (a typo would silently drop it: for _ALLOWED_DOMAINS that is a security rule). Settings are AUTH_PROVIDER_<KEY>_<${SETTINGS.join("|")}> with <KEY> one of ${PROVIDER_KEYS.map((key) => key.toUpperCase().replace(/-/g, "_")).join(", ")}.`,
    );
  }

  for (const name of listedNames(env)) {
    // An own key only: `AUTH_PROVIDERS=constructor` must be an unknown name, not a lookup on Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(PROVIDER_DESCRIPTORS, name)) {
      problems.push(`AUTH_PROVIDERS lists "${name}", which is not a known sign-in provider (known: ${PROVIDER_KEYS.join(", ")}). Fix the spelling or remove it; local accounts are always available and are not listed.`);
      continue;
    }
    const descriptor: ProviderDescriptor = PROVIDER_DESCRIPTORS[name as ProviderKey];
    const own: string[] = [];
    const setting = (s: ProviderSetting) => value(env, providerEnvName(name, s));
    const missing = (s: ProviderSetting) => own.push(`AUTH_PROVIDERS lists "${name}" but ${providerEnvName(name, s)} is not set.`);

    const clientId = setting("CLIENT_ID");
    const clientSecret = setting("CLIENT_SECRET");
    if (clientId === undefined) missing("CLIENT_ID");
    if (clientSecret === undefined) missing("CLIENT_SECRET");

    const issuer = descriptor.needsIssuer ? setting("ISSUER") : undefined;
    if (descriptor.needsIssuer) {
      if (issuer === undefined) missing("ISSUER");
      else {
        const problem = issuerProblem(issuer, env);
        if (problem) own.push(`${providerEnvName(name, "ISSUER")} ("${issuer}") ${problem} (provider "${name}").`);
      }
    }

    const configuredLabel = setting("LABEL");
    if (descriptor.needsLabel && configuredLabel === undefined) missing("LABEL");

    const linkRaw = setting("LINK_EXISTING_USERS");
    if (linkRaw !== undefined && linkRaw !== "0" && linkRaw !== "1") {
      own.push(`${providerEnvName(name, "LINK_EXISTING_USERS")} is "${linkRaw}": only 1 turns linking of existing users on; leave it unset or 0 to keep it off (provider "${name}").`);
    }

    const allowedDomains = parseDomains(setting("ALLOWED_DOMAINS"), providerEnvName(name, "ALLOWED_DOMAINS"), own);

    if (own.length > 0) {
      problems.push(...own);
      continue;
    }
    const label = configuredLabel ?? descriptor.name;
    const linkExistingUsers = linkRaw === "1";
    enabled.push({
      id: descriptor.key,
      label,
      policy: { id: descriptor.key, verifiedEmailGuaranteed: descriptor.verifiedEmailGuaranteed, verifiedEmailClaim: descriptor.verifiedEmailClaim, allowedDomains, linkExistingUsers },
      provider: descriptor.factory({ clientId: clientId!, clientSecret: clientSecret!, issuer, label, linkExistingUsers }),
    });
  }

  return { enabled: unknownSettings.length > 0 ? [] : enabled, problems };
}

/** Problems already written to the log by this process: the login page asks on every request, and a mistake is said once. */
const logged = new Set<string>();

/** For tests: forget what was logged. */
export function resetProviderProblemLog(): void {
  logged.clear();
}

/**
 * The enabled providers, with each problem written to the log once (development, test and production alike: in production the server has refused
 * to start already, `refuseToStartWithBadProviderConfiguration`, so this is what a build or a test sees). Never throws.
 */
export function enabledProviders(env: Env = process.env): readonly EnabledProvider[] {
  const { enabled, problems } = resolveProviderRegistry(env);
  for (const problem of problems) {
    if (logged.has(problem)) continue;
    logged.add(problem);
    console.error(`[auth] sign-in provider configuration: ${problem} It is ignored.`);
  }
  return enabled;
}

/** What the login page shows: a button for each enabled provider, in the order of `AUTH_PROVIDERS`. */
export function providerButtons(env: Env = process.env): { id: string; label: string }[] {
  return enabledProviders(env).map(({ id, label }) => ({ id, label }));
}

/** Every problem of the configuration (empty when it is sound). */
export function providerConfigurationProblems(env: Env = process.env): readonly string[] {
  return resolveProviderRegistry(env).problems;
}

/** Throws, with every problem, when this is a production server (`NODE_ENV=production`) whose provider configuration has any. Development and test are never affected. */
export function assertProviderConfiguration(env: Env = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const problems = providerConfigurationProblems(env);
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production: the sign-in provider configuration has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * What a production server does with a bad provider configuration: write the reasons and END THE PROCESS (exit code 1), exactly like the secret check
 * (`refuseToStartWithoutProductionSecret`, src/lib/auth-secret.ts: a throw from the instrumentation hook would leave `next start` answering 500).
 * Nothing happens in development and test, or for a sound configuration (no provider at all is sound).
 */
export function refuseToStartWithBadProviderConfiguration(
  env: Env = process.env,
  deps: { write?: (text: string, done: () => void) => void; exit?: (code: number) => void } = {},
): void {
  const write = deps.write ?? ((text, done) => void process.stderr.write(text, done));
  const exit = deps.exit ?? ((code) => process.exit(code));
  try {
    assertProviderConfiguration(env);
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`, () => exit(1));
  }
}
