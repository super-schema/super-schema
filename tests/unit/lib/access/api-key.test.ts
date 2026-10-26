// @vitest-environment node
/**
 * The REST API key as a service principal (src/lib/access/api-key.ts): which tenant and role it stands for, that a setting that is not a role
 * turns it off instead of widening it, and that it is compared in constant time whatever the length of what was presented.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_KEY_USER_ID, DEFAULT_API_KEY_TENANT_ID, apiKeyMatches, apiKeyPrincipal } from "@/lib/access/api-key";
import { can } from "@/lib/access";
import { DEFAULT_TENANT_ID } from "@/lib/org-defaults";

vi.mock("@/lib/db", () => ({ prisma: {} }));

afterEach(() => vi.restoreAllMocks());

describe("apiKeyPrincipal", () => {
  it("is off without an API_KEY, whatever the other settings say", () => {
    expect(apiKeyPrincipal({})).toBeNull();
    expect(apiKeyPrincipal({ API_KEY: "", API_KEY_ROLE: "ADMIN" })).toBeNull();
    expect(apiKeyPrincipal({ API_KEY: "   " })).toBeNull();
  });

  it("defaults: an administrator acting in the default tenant (what the key has always been)", () => {
    const key = apiKeyPrincipal({ API_KEY: "k" });
    expect(key?.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(DEFAULT_API_KEY_TENANT_ID).toBe(DEFAULT_TENANT_ID);
    expect(key?.role).toBe("ADMIN");
    expect(key?.principal.userId).toBe(API_KEY_USER_ID);
    expect(key?.principal.isGlobalAdmin).toBe(true);
    expect(key?.principal.assignments).toEqual([{ role: "ADMIN", scope: { kind: "GLOBAL" } }]);
  });

  it("a lower role is held at TENANT scope in the named tenant only, and carries no platform rights", () => {
    for (const role of ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"]) {
      const key = apiKeyPrincipal({ API_KEY: "k", API_KEY_ROLE: role, API_KEY_TENANT_ID: "t7" });
      expect(key?.principal.assignments, role).toEqual([{ role, scope: { kind: "TENANT", tenantId: "t7" } }]);
      expect(key?.principal.isGlobalAdmin, role).toBe(false);
      expect(can(key!.principal.assignments, "platform.admin", { tenantId: "t7" }), role).toBe(false);
      expect(can(key!.principal.assignments, "entity.read", { tenantId: "t7" }), role).toBe(true);
      expect(can(key!.principal.assignments, "entity.read", { tenantId: "other" }), role).toBe(false);
    }
  });

  it("a setting that is not a role turns the key off (never an administrator by default)", () => {
    for (const role of ["admin", "root", "ADMINISTRATOR", "constructor", "__proto__", "toString", "0"]) {
      expect(apiKeyPrincipal({ API_KEY: "k", API_KEY_ROLE: role }), role).toBeNull();
    }
  });

  it("settings are trimmed: a space in an .env line is not a different tenant or role; blank is the default", () => {
    expect(apiKeyPrincipal({ API_KEY: "k", API_KEY_ROLE: " VIEWER ", API_KEY_TENANT_ID: " t3 " })?.tenantId).toBe("t3");
    expect(apiKeyPrincipal({ API_KEY: "k", API_KEY_ROLE: " ", API_KEY_TENANT_ID: "" })?.role).toBe("ADMIN");
  });

  it("the principal cannot be widened by a caller (frozen)", () => {
    const key = apiKeyPrincipal({ API_KEY: "k", API_KEY_ROLE: "VIEWER" })!;
    expect(Object.isFrozen(key.principal)).toBe(true);
    expect(Object.isFrozen(key.principal.assignments)).toBe(true);
  });
});

describe("apiKeyMatches", () => {
  it("accepts exactly the key and nothing else", () => {
    expect(apiKeyMatches("secret-key", { API_KEY: "secret-key" })).toBe(true);
    for (const wrong of ["secret-ke", "secret-keyy", "Secret-key", "", " secret-key", "secret-key "]) {
      expect(apiKeyMatches(wrong, { API_KEY: "secret-key" }), JSON.stringify(wrong)).toBe(false);
    }
  });

  it("is false when no key is configured, even for an empty token", () => {
    expect(apiKeyMatches("", {})).toBe(false);
    expect(apiKeyMatches("anything", { API_KEY: "" })).toBe(false);
    expect(apiKeyMatches("anything", {})).toBe(false);
  });

  it("compares in constant time: always two buffers of the same length, whatever the lengths presented (nothing of the key's length shows)", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    for (const presented of ["x", "secret-key", "a-much-longer-token-than-the-key-that-is-configured-here"]) apiKeyMatches(presented, { API_KEY: "secret-key" });
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
  });
});
