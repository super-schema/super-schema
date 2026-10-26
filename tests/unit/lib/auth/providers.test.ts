/**
 * The sign-in provider registry (src/lib/auth/providers.ts): ONE typed table of the providers Auth.js can offer here, selected by `AUTH_PROVIDERS`.
 * The default is empty: the local credentials provider is the only way in. What is pinned: each descriptor's required settings, the env names,
 * the handling of a configuration mistake (an unknown name, a missing setting, a typo in a setting name: logged and ignored in development and
 * test, a refusal to start in production, never a silently disabled rule), and that `google` is only a row of the table like the others.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_DESCRIPTORS,
  PROVIDER_KEYS,
  assertProviderConfiguration,
  enabledProviders,
  providerButtons,
  providerConfigurationProblems,
  providerEnvName,
  providerEnvNames,
  refuseToStartWithBadProviderConfiguration,
  resetProviderProblemLog,
  resolveProviderRegistry,
} from "@/lib/auth/providers";

beforeEach(() => resetProviderProblemLog());
afterEach(() => vi.restoreAllMocks());

/** Every setting a provider needs, as an environment. */
function fullSettings(key: string, extra: Record<string, string> = {}): Record<string, string> {
  const descriptor = PROVIDER_DESCRIPTORS[key as keyof typeof PROVIDER_DESCRIPTORS];
  return {
    AUTH_PROVIDERS: key,
    [providerEnvName(key, "CLIENT_ID")]: `${key}-client-id`,
    [providerEnvName(key, "CLIENT_SECRET")]: `${key}-client-secret`,
    ...(descriptor.needsIssuer ? { [providerEnvName(key, "ISSUER")]: "https://idp.example.test/realms/acme" } : {}),
    ...(descriptor.needsLabel ? { [providerEnvName(key, "LABEL")]: "Acme single sign-on" } : {}),
    ...extra,
  };
}

describe("the table", () => {
  it("has exactly the providers the task names: google, github, microsoft-entra-id, okta, keycloak and a generic oidc", () => {
    expect([...PROVIDER_KEYS]).toEqual(["google", "github", "microsoft-entra-id", "okta", "keycloak", "oidc"]);
    expect(Object.keys(PROVIDER_DESCRIPTORS)).toEqual([...PROVIDER_KEYS]);
  });

  it("which of them need an issuer, a display name, and report a verified e-mail by themselves (what the descriptors say)", () => {
    const summary = Object.fromEntries(
      PROVIDER_KEYS.map((key) => {
        const d = PROVIDER_DESCRIPTORS[key];
        return [key, { issuer: d.needsIssuer, label: d.needsLabel, guaranteed: d.verifiedEmailGuaranteed, claim: d.verifiedEmailClaim }];
      }),
    );
    expect(summary).toEqual({
      google: { issuer: false, label: false, guaranteed: false, claim: "email_verified" },
      github: { issuer: false, label: false, guaranteed: true, claim: "email_verified" },
      "microsoft-entra-id": { issuer: true, label: false, guaranteed: false, claim: "xms_edov" },
      okta: { issuer: true, label: false, guaranteed: false, claim: "email_verified" },
      keycloak: { issuer: true, label: false, guaranteed: false, claim: "email_verified" },
      oidc: { issuer: true, label: true, guaranteed: false, claim: "email_verified" },
    });
  });
});

describe("the environment names", () => {
  it("are AUTH_PROVIDER_<KEY>_<SETTING>, the key upper-cased with a dash as an underscore", () => {
    expect(providerEnvName("google", "CLIENT_ID")).toBe("AUTH_PROVIDER_GOOGLE_CLIENT_ID");
    expect(providerEnvName("microsoft-entra-id", "CLIENT_SECRET")).toBe("AUTH_PROVIDER_MICROSOFT_ENTRA_ID_CLIENT_SECRET");
    expect(providerEnvName("oidc", "ISSUER")).toBe("AUTH_PROVIDER_OIDC_ISSUER");
    expect(providerEnvName("keycloak", "ALLOWED_DOMAINS")).toBe("AUTH_PROVIDER_KEYCLOAK_ALLOWED_DOMAINS");
    expect(providerEnvName("okta", "LINK_EXISTING_USERS")).toBe("AUTH_PROVIDER_OKTA_LINK_EXISTING_USERS");
    expect(providerEnvName("github", "LABEL")).toBe("AUTH_PROVIDER_GITHUB_LABEL");
  });

  it("providerEnvNames lists every one of them (and the issuer only where a provider has one)", () => {
    const names = providerEnvNames();
    expect(names).toContain("AUTH_PROVIDER_GOOGLE_CLIENT_ID");
    expect(names).toContain("AUTH_PROVIDER_OIDC_ISSUER");
    expect(names).toContain("AUTH_PROVIDER_GITHUB_LINK_EXISTING_USERS");
    expect(names).not.toContain("AUTH_PROVIDER_GOOGLE_ISSUER");
    expect(names).not.toContain("AUTH_PROVIDER_GITHUB_ISSUER");
    expect(new Set(names).size).toBe(names.length);
    // client id + secret + domains + link flag + label for each (5) and the issuer for the four that need one
    expect(names).toHaveLength(PROVIDER_KEYS.length * 5 + 4);
  });
});

describe("the default: no provider (local accounts only)", () => {
  it.each([undefined, "", "   ", ",", " , ,"])("AUTH_PROVIDERS=%j enables nothing and is no problem", (value) => {
    const registry = resolveProviderRegistry(value === undefined ? {} : { AUTH_PROVIDERS: value });
    expect(registry.enabled).toEqual([]);
    expect(registry.problems).toEqual([]);
    expect(providerButtons(value === undefined ? {} : { AUTH_PROVIDERS: value })).toEqual([]);
  });

  it("settings of providers that are not listed are ignored (they are known names, so no typo)", () => {
    const env = { ...fullSettings("google"), AUTH_PROVIDERS: "" };
    expect(resolveProviderRegistry(env)).toEqual({ enabled: [], problems: [] });
  });
});

describe("each descriptor requires its settings", () => {
  it.each(PROVIDER_KEYS)("%s is enabled with its settings, under the Auth.js provider id of its key", (key) => {
    const { enabled, problems } = resolveProviderRegistry(fullSettings(key));
    expect(problems).toEqual([]);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe(key);
    expect((enabled[0].provider as { id: string }).id).toBe(key);
    expect(enabled[0].label).toBe(key === "oidc" ? "Acme single sign-on" : PROVIDER_DESCRIPTORS[key].name);
    expect(enabled[0].policy).toEqual({
      id: key,
      verifiedEmailGuaranteed: PROVIDER_DESCRIPTORS[key].verifiedEmailGuaranteed,
      verifiedEmailClaim: PROVIDER_DESCRIPTORS[key].verifiedEmailClaim,
      allowedDomains: [],
      linkExistingUsers: false,
    });
  });

  it.each(PROVIDER_KEYS)("%s without its client id, its client secret (or an issuer, or a display name where it needs one) is a configuration error naming the missing setting, and is not enabled", (key) => {
    const complete = fullSettings(key);
    const required = Object.keys(complete).filter((name) => name !== "AUTH_PROVIDERS");
    expect(required.length).toBeGreaterThanOrEqual(2);
    for (const missing of required) {
      const env = { ...complete };
      delete env[missing];
      const { enabled, problems } = resolveProviderRegistry(env);
      expect(enabled, missing).toEqual([]);
      expect(problems, missing).toHaveLength(1);
      expect(problems[0], missing).toContain(missing);
      expect(problems[0], missing).toContain(`"${key}"`);
    }
    // a blank value is a missing one
    const blank = { ...complete, [providerEnvName(key, "CLIENT_SECRET")]: "   " };
    expect(resolveProviderRegistry(blank).enabled).toEqual([]);
  });

  it("the issuer must be an http(s) URL", () => {
    for (const issuer of ["idp.example.test", "ftp://idp.example.test", "not a url", "javascript:alert(1)"]) {
      const { enabled, problems } = resolveProviderRegistry(fullSettings("okta", { AUTH_PROVIDER_OKTA_ISSUER: issuer }));
      expect(enabled, issuer).toEqual([]);
      expect(problems[0], issuer).toContain("AUTH_PROVIDER_OKTA_ISSUER");
    }
  });

  it("the issuer must be https in production (plain http only in development and test, for a local identity provider)", () => {
    const env = fullSettings("keycloak", { AUTH_PROVIDER_KEYCLOAK_ISSUER: "http://localhost:8080/realms/acme" });
    expect(resolveProviderRegistry(env).enabled).toHaveLength(1);
    expect(resolveProviderRegistry({ ...env, NODE_ENV: "production" }).enabled).toEqual([]);
    expect(resolveProviderRegistry({ ...env, NODE_ENV: "production" }).problems[0]).toMatch(/https/);
  });

  it("the display name of a provider defaults to its name and is changed by _LABEL", () => {
    expect(resolveProviderRegistry(fullSettings("google")).enabled[0].label).toBe("Google");
    expect(resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_LABEL: " Staff sign-in " })).enabled[0].label).toBe("Staff sign-in");
    expect(providerButtons(fullSettings("google", { AUTH_PROVIDER_GOOGLE_LABEL: "Staff sign-in" }))).toEqual([{ id: "google", label: "Staff sign-in" }]);
  });
});

describe("AUTH_PROVIDERS", () => {
  it("is a comma list: spaces, letter case, empty entries and repeats do not matter, and the order is kept", () => {
    const env = { ...fullSettings("okta"), ...fullSettings("github"), AUTH_PROVIDERS: " Okta, ,GITHUB,okta" };
    expect(resolveProviderRegistry(env).enabled.map((p) => p.id)).toEqual(["okta", "github"]);
    expect(providerButtons(env)).toEqual([
      { id: "okta", label: "Okta" },
      { id: "github", label: "GitHub" },
    ]);
  });

  it("an unknown name is a configuration error that says which names exist; the valid ones stay enabled, the unknown one never is", () => {
    const env = { ...fullSettings("okta"), AUTH_PROVIDERS: "okta,gogle" };
    const { enabled, problems } = resolveProviderRegistry(env);
    expect(enabled.map((p) => p.id)).toEqual(["okta"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AUTH_PROVIDERS");
    expect(problems[0]).toContain('"gogle"');
    for (const key of PROVIDER_KEYS) expect(problems[0]).toContain(key);
  });

  it("credentials is not a name of the list: it is always there, and cannot be switched off or on from here", () => {
    const { enabled, problems } = resolveProviderRegistry({ AUTH_PROVIDERS: "credentials" });
    expect(enabled).toEqual([]);
    expect(problems[0]).toContain('"credentials"');
  });
});

describe("a typo in a setting name is an error too (it would silently drop the setting: for _ALLOWED_DOMAINS, a security rule)", () => {
  it("an AUTH_PROVIDER_* name that no provider has is reported, by name, even for a provider that is not listed", () => {
    const env = { ...fullSettings("google"), AUTH_PROVIDER_GOOGLE_ALLOWD_DOMAINS: "example.com" };
    const { enabled, problems } = resolveProviderRegistry(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("AUTH_PROVIDER_GOOGLE_ALLOWD_DOMAINS");
    // the provider itself is enabled only when its OWN settings are right: here they are, but a mistaken sibling makes the whole configuration suspect
    expect(enabled).toEqual([]);
  });

  it("an empty unknown name is not reported (nothing is lost by it), AUTH_PROVIDERS itself is not an unknown name", () => {
    const env = { ...fullSettings("google"), AUTH_PROVIDER_GOOGLE_ALLOWD_DOMAINS: "" };
    expect(resolveProviderRegistry(env).problems).toEqual([]);
  });
});

describe("_ALLOWED_DOMAINS", () => {
  it("is a comma list, normalised (trimmed, lower case)", () => {
    const { enabled, problems } = resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS: " Example.com, .Corp.Example.org ,example.com" }));
    expect(problems).toEqual([]);
    expect(enabled[0].policy.allowedDomains).toEqual(["example.com", ".corp.example.org"]);
  });

  it.each(["*.example.com", "@example.com", "user@example.com", "example", "exa mple.com", "https://example.com", ".", "example.com/"])(
    "an entry that can never match (%j) is an error, not a rule that silently locks everyone out or drops the restriction",
    (entry) => {
      const { enabled, problems } = resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS: `example.org,${entry}` }));
      expect(enabled).toEqual([]);
      expect(problems[0]).toContain("AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS");
    },
  );

  it("a value that lists no domain at all is an error (an empty list would mean 'no restriction')", () => {
    const { enabled, problems } = resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS: " , " }));
    expect(enabled).toEqual([]);
    expect(problems[0]).toContain("AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS");
  });

  it("unset or blank means no restriction", () => {
    expect(resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_ALLOWED_DOMAINS: "" })).enabled[0].policy.allowedDomains).toEqual([]);
  });
});

describe("_LINK_EXISTING_USERS", () => {
  const optionsOf = (env: Record<string, string>) => {
    const provider = resolveProviderRegistry(env).enabled[0]?.provider as { options?: { allowDangerousEmailAccountLinking?: boolean }; allowDangerousEmailAccountLinking?: boolean } | undefined;
    return provider?.options?.allowDangerousEmailAccountLinking ?? provider?.allowDangerousEmailAccountLinking;
  };

  it.each(PROVIDER_KEYS)("%s: off by default, and Auth.js's allowDangerousEmailAccountLinking is off with it", (key) => {
    const registry = resolveProviderRegistry(fullSettings(key));
    expect(registry.enabled[0].policy.linkExistingUsers).toBe(false);
    expect(optionsOf(fullSettings(key))).toBe(false);
  });

  it.each(PROVIDER_KEYS)("%s: 1 turns it on in the policy AND in Auth.js, nothing else does", (key) => {
    const on = fullSettings(key, { [providerEnvName(key, "LINK_EXISTING_USERS")]: "1" });
    expect(resolveProviderRegistry(on).enabled[0].policy.linkExistingUsers).toBe(true);
    expect(optionsOf(on)).toBe(true);
    for (const value of ["", "0", " 0 "]) {
      const off = fullSettings(key, { [providerEnvName(key, "LINK_EXISTING_USERS")]: value });
      expect(resolveProviderRegistry(off).problems, JSON.stringify(value)).toEqual([]);
      expect(resolveProviderRegistry(off).enabled[0].policy.linkExistingUsers, JSON.stringify(value)).toBe(false);
    }
  });

  it.each(["true", "yes", "on", "ture", "2", "enabled"])("%j is a configuration error (only 1 enables it, 0 or unset keeps it off), and the provider is not enabled", (value) => {
    const { enabled, problems } = resolveProviderRegistry(fullSettings("google", { AUTH_PROVIDER_GOOGLE_LINK_EXISTING_USERS: value }));
    expect(enabled).toEqual([]);
    expect(problems[0]).toContain("AUTH_PROVIDER_GOOGLE_LINK_EXISTING_USERS");
  });
});

describe("handling of a configuration mistake by NODE_ENV", () => {
  const broken = { ...fullSettings("okta"), AUTH_PROVIDERS: "okta,gogle,keycloak" }; // an unknown name and a provider without settings

  it.each(["development", "test", undefined])("%s: logged once each, the rest of the configuration still works, nothing throws", (nodeEnv) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { ...broken, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) };
    expect(enabledProviders(env).map((p) => p.id)).toEqual(["okta"]);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/gogle/);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/AUTH_PROVIDER_KEYCLOAK_CLIENT_ID/);
    expect(() => assertProviderConfiguration(env)).not.toThrow();
    const again = error.mock.calls.length;
    enabledProviders(env); // the same mistakes are not repeated on every request
    expect(error.mock.calls.length).toBe(again);
  });

  it("production: the runtime still never enables what is wrong (it never throws while a module loads: `next build` imports it without the settings), and starting is refused with every problem", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { ...broken, NODE_ENV: "production" };
    expect(enabledProviders(env).map((p) => p.id)).toEqual(["okta"]);
    expect(() => assertProviderConfiguration(env)).toThrow(/Refusing to start in production/);
    expect(() => assertProviderConfiguration(env)).toThrow(/gogle/);
    expect(() => assertProviderConfiguration(env)).toThrow(/AUTH_PROVIDER_KEYCLOAK_CLIENT_ID/);
  });

  it("production with a sound configuration (or none at all) starts", () => {
    expect(() => assertProviderConfiguration({ NODE_ENV: "production" })).not.toThrow();
    expect(() => assertProviderConfiguration({ ...fullSettings("okta"), NODE_ENV: "production" })).not.toThrow();
  });

  it("refuseToStartWithBadProviderConfiguration writes the reason and ends the process with code 1, in production only (the pattern of the secret refusal)", () => {
    const write = vi.fn((_text: string, done: () => void) => done());
    const exit = vi.fn();
    refuseToStartWithBadProviderConfiguration({ ...broken, NODE_ENV: "production" }, { write, exit });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatch(/Refusing to start in production[\s\S]*gogle/);
    expect(exit).toHaveBeenCalledWith(1);

    for (const nodeEnv of ["development", "test", undefined]) {
      write.mockClear();
      exit.mockClear();
      refuseToStartWithBadProviderConfiguration({ ...broken, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) }, { write, exit });
      expect(write, String(nodeEnv)).not.toHaveBeenCalled();
      expect(exit, String(nodeEnv)).not.toHaveBeenCalled();
    }
    refuseToStartWithBadProviderConfiguration({ ...fullSettings("okta"), NODE_ENV: "production" }, { write, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("providerConfigurationProblems is the list the refusal is made of (empty when sound)", () => {
    expect(providerConfigurationProblems({})).toEqual([]);
    // the unknown name (1) and the three settings the keycloak entry lacks: client id, client secret, issuer (3)
    expect(providerConfigurationProblems(broken)).toHaveLength(4);
  });
});

describe("google is a row of the table like the others (no special code)", () => {
  const authFiles = ["src/lib/auth/providers.ts", "src/lib/auth/provider-signin.ts", "src/lib/auth.ts", "src/env.ts"];
  const read = (file: string) => readFileSync(path.resolve(__dirname, "../../../..", file), "utf8");

  it("the name appears in the one table entry and the import of its factory, nowhere else in the registry, the policy, the Auth.js configuration or the environment declaration", () => {
    for (const file of authFiles) {
      const text = read(file);
      // the `google: { ... }` row of the descriptor table, which ends at the first line of two spaces and a closing brace
      const outsideTheRow = text.replace(/^ {2}google: \{[\s\S]*?^ {2}\},$/m, "");
      const hits = outsideTheRow.split("\n").filter((line) => /google/i.test(line));
      const allowed = file === "src/lib/auth/providers.ts" ? ['import Google from "next-auth/providers/google";'] : [];
      expect(hits, `${file}: ${hits.join(" | ")}`).toEqual(allowed);
    }
  });

  it("behaves like any other row: the same settings give the same shape of result for google and for each other key", () => {
    const shapes = PROVIDER_KEYS.map((key) => {
      const registry = resolveProviderRegistry(fullSettings(key));
      return { problems: registry.problems.length, enabled: registry.enabled.length, linkOff: registry.enabled[0].policy.linkExistingUsers, domains: registry.enabled[0].policy.allowedDomains.length };
    });
    for (const shape of shapes) expect(shape).toEqual({ problems: 0, enabled: 1, linkOff: false, domains: 0 });
  });
});
