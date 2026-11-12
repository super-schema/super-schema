import { describe, expect, it } from "vitest";
import { checkSsoConfiguration } from "@/lib/auth/sso-configuration";

const env = {
  NODE_ENV: "production", AUTH_URL: "https://schemas.example.com", AUTH_SECRET: "f83bcfa8479b4fc3b04e8136ade278ac",
  AUTH_PROVIDERS: "oidc", AUTH_PROVIDER_OIDC_CLIENT_ID: "schemas", AUTH_PROVIDER_OIDC_CLIENT_SECRET: "never-print-this-value",
  AUTH_PROVIDER_OIDC_ISSUER: "https://idp.example.com/realms/acme", AUTH_PROVIDER_OIDC_LABEL: "Company SSO",
  AUTH_PROVIDER_OIDC_ALLOWED_DOMAINS: "example.com",
};

describe("offline SSO deployment check", () => {
  it("reports the exact callback and policy without exposing credentials", () => {
    const report = checkSsoConfiguration(env);
    expect(report.problems).toEqual([]);
    expect(report.providers).toEqual([{ id: "oidc", label: "Company SSO", callbackUrl: "https://schemas.example.com/api/auth/callback/oidc", allowedDomains: ["example.com"], linkExistingUsers: false }]);
    expect(JSON.stringify(report)).not.toContain(env.AUTH_PROVIDER_OIDC_CLIENT_SECRET);
    expect(JSON.stringify(report)).not.toContain(env.AUTH_SECRET);
  });

  it.each(["http://schemas.example.com", "https://schemas.example.com/other", "https://user:secret@schemas.example.com", "https://schemas.example.com?x=1", "", "not-a-url"])("rejects an unsafe or unusable production origin: %s", (AUTH_URL) => {
    expect(checkSsoConfiguration({ ...env, AUTH_URL }).problems.join(" ")).toContain("AUTH_URL");
  });

  it("supports the legacy URL and secret names and Auth.js's default base path", () => {
    expect(checkSsoConfiguration({ ...env, AUTH_URL: "", NEXTAUTH_URL: `${env.AUTH_URL}/api/auth`, AUTH_SECRET: "", NEXTAUTH_SECRET: env.AUTH_SECRET }).problems).toEqual([]);
  });

  it.each(["", "short", "dev-secret-change-in-production"])("refuses an absent or weak production secret without echoing it", (AUTH_SECRET) => {
    const report = checkSsoConfiguration({ ...env, AUTH_SECRET });
    expect(report.problems.join(" ")).toContain("AUTH_SECRET");
    if (AUTH_SECRET) expect(JSON.stringify(report)).not.toContain(AUTH_SECRET);
  });

  it("requires an enabled provider and reports missing settings", () => {
    expect(checkSsoConfiguration({ ...env, AUTH_PROVIDERS: "" }).problems.join(" ")).toContain("AUTH_PROVIDERS");
    expect(checkSsoConfiguration({ ...env, AUTH_PROVIDER_OIDC_CLIENT_SECRET: "" }).problems.join(" ")).toContain("AUTH_PROVIDER_OIDC_CLIENT_SECRET");
  });

  it("allows HTTP only for loopback development", () => {
    expect(checkSsoConfiguration({ ...env, NODE_ENV: "development", AUTH_URL: "http://localhost:3000" }).problems).toEqual([]);
    expect(checkSsoConfiguration({ ...env, NODE_ENV: "development", AUTH_URL: "http://schemas.example.com" }).problems.join(" ")).toContain("AUTH_URL");
  });
});
