/**
 * Where the client address comes from, and what is kept of it. The address is read from `X-Forwarded-For` ONLY when the operator says there is a
 * proxy in front that sets it (`AUTH_TRUST_PROXY=1`): the header is whatever the client writes otherwise, and trusting it would let anyone pick
 * their own throttle bucket. Without trust every request is in one constant bucket ("untrusted"), which still throttles per e-mail. What is
 * stored is an HMAC keyed with the auth secret, never the e-mail or the address (that is checked against the database in
 * tests/integration/auth/throttle-pglite.test.ts).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The functions under test are pure; the module also holds the database half, which must not open a database here.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { UNTRUSTED_IP, clientIp, hashEmail, hashIp } from "@/lib/auth/throttle";
import { trustProxyStartupWarning } from "@/lib/auth/client-ip";

const headers = (values: Record<string, string>) => new Headers(values);

describe("clientIp", () => {
  it("is the constant 'untrusted' bucket when AUTH_TRUST_PROXY is not 1, whatever the header says", () => {
    const spoof = headers({ "x-forwarded-for": "203.0.113.7" });
    for (const env of [{}, { AUTH_TRUST_PROXY: "" }, { AUTH_TRUST_PROXY: "0" }, { AUTH_TRUST_PROXY: "true" }, { AUTH_TRUST_PROXY: "yes" }, { AUTH_TRUST_PROXY: " 1" }]) {
      expect(clientIp(spoof, env), JSON.stringify(env)).toBe(UNTRUSTED_IP);
    }
    expect(UNTRUSTED_IP).toBe("untrusted");
  });

  it("is the left-most entry of X-Forwarded-For when AUTH_TRUST_PROXY=1", () => {
    const env = { AUTH_TRUST_PROXY: "1" };
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7" }), env)).toBe("203.0.113.7");
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }), env)).toBe("203.0.113.7");
    expect(clientIp(headers({ "x-forwarded-for": "  198.51.100.4  ,10.0.0.1" }), env)).toBe("198.51.100.4");
    expect(clientIp(headers({ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }), env)).toBe("2001:db8::1");
  });

  it("falls back to the constant bucket when trust is on but the header is missing, empty or not an address (a garbage value must not make a bucket of its own)", () => {
    const env = { AUTH_TRUST_PROXY: "1" };
    expect(clientIp(headers({}), env)).toBe(UNTRUSTED_IP);
    expect(clientIp(headers({ "x-forwarded-for": "" }), env)).toBe(UNTRUSTED_IP);
    expect(clientIp(headers({ "x-forwarded-for": "not-an-ip" }), env)).toBe(UNTRUSTED_IP);
    expect(clientIp(headers({ "x-forwarded-for": "1.2.3.4.5" }), env)).toBe(UNTRUSTED_IP);
    expect(clientIp(headers({ "x-forwarded-for": `${"9".repeat(500)}` }), env)).toBe(UNTRUSTED_IP);
    expect(clientIp(headers({ "x-forwarded-for": ",203.0.113.7" }), env)).toBe(UNTRUSTED_IP);
  });

  // `next start` puts the socket's own address in X-Forwarded-For when a request carries none (base-server.js: `x-forwarded-for ??= remoteAddress`), so with trust on
  // and no proxy in front EVERY client arrives as the loopback address. That is not a client: it is the shared bucket, with the shared ceiling.
  it("a loopback address (what Next itself writes when no proxy did) is the shared bucket, not a client of its own", () => {
    const env = { AUTH_TRUST_PROXY: "1" };
    for (const value of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1", "127.0.0.1, 203.0.113.7"]) {
      expect(clientIp(headers({ "x-forwarded-for": value }), env), value).toBe(UNTRUSTED_IP);
    }
    // an address that only looks like one is still an address
    for (const value of ["128.0.0.1", "126.255.255.255", "::2", "2001:db8::1", "::ffff:128.0.0.1", "10.0.0.1"]) {
      expect(clientIp(headers({ "x-forwarded-for": value }), env), value).toBe(value.toLowerCase());
    }
  });

  it("does not read any other header (X-Real-IP, Forwarded, CF-Connecting-IP are not the contract)", () => {
    const env = { AUTH_TRUST_PROXY: "1" };
    expect(clientIp(headers({ "x-real-ip": "203.0.113.7", forwarded: "for=203.0.113.8", "cf-connecting-ip": "203.0.113.9" }), env)).toBe(UNTRUSTED_IP);
  });

  it("reads process.env when no environment is given", () => {
    const before = process.env.AUTH_TRUST_PROXY;
    try {
      process.env.AUTH_TRUST_PROXY = "1";
      expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
      delete process.env.AUTH_TRUST_PROXY;
      expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7" }))).toBe(UNTRUSTED_IP);
    } finally {
      if (before === undefined) delete process.env.AUTH_TRUST_PROXY;
      else process.env.AUTH_TRUST_PROXY = before;
    }
  });

  it("writes IPv6 addresses in one spelling (lower case)", () => {
    expect(clientIp(headers({ "x-forwarded-for": "2001:DB8::ABCD" }), { AUTH_TRUST_PROXY: "1" })).toBe("2001:db8::abcd");
  });
});

describe("what is stored of an e-mail address and of a client address", () => {
  const saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  beforeEach(() => {
    process.env.AUTH_SECRET = "throttle-test-secret-one-0123456789";
    delete process.env.NEXTAUTH_SECRET;
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("is a 64-character hex digest that holds neither the e-mail nor the address", () => {
    const email = hashEmail("alice@example.com");
    const ip = hashIp("203.0.113.7");
    expect(email).toMatch(/^[0-9a-f]{64}$/);
    expect(ip).toMatch(/^[0-9a-f]{64}$/);
    expect(email).not.toContain("alice");
    expect(ip).not.toContain("203.0.113.7");
  });

  it("is the same for the same value, whatever the letter case or padding of an e-mail", () => {
    expect(hashEmail("  Alice@Example.COM ")).toBe(hashEmail("alice@example.com"));
    expect(hashIp("203.0.113.7")).toBe(hashIp("203.0.113.7"));
  });

  it("differs between values, and between an e-mail and an address that spell the same (the two never share a bucket)", () => {
    expect(hashEmail("alice@example.com")).not.toBe(hashEmail("bob@example.com"));
    expect(hashIp("203.0.113.7")).not.toBe(hashIp("203.0.113.8"));
    expect(hashEmail("same")).not.toBe(hashIp("same"));
  });

  it("is KEYED with the auth secret: another secret gives other digests (no table of e-mail hashes can be computed without it)", () => {
    const first = hashEmail("alice@example.com");
    process.env.AUTH_SECRET = "throttle-test-secret-two-9876543210";
    expect(hashEmail("alice@example.com")).not.toBe(first);
    expect(hashEmail("alice@example.com")).not.toBe(
      // ... and it is not a bare SHA-256 of the value either
      createHash("sha256").update("alice@example.com").digest("hex"),
    );
  });

  it("uses NEXTAUTH_SECRET when AUTH_SECRET is not set (the one rule of src/lib/auth-secret.ts)", () => {
    delete process.env.AUTH_SECRET;
    process.env.NEXTAUTH_SECRET = "throttle-test-secret-three-abcdef";
    expect(hashIp("203.0.113.7")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to hash without a secret instead of falling back to an unkeyed digest", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    expect(() => hashEmail("alice@example.com")).toThrow(/secret/i);
    expect(() => hashIp("203.0.113.7")).toThrow(/secret/i);
  });
});

describe("trustProxyStartupWarning (what a production start says about the missing client address)", () => {
  it("is a warning for production without AUTH_TRUST_PROXY=1, and names the setting", () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", AUTH_TRUST_PROXY: "0" }, { NODE_ENV: "production", AUTH_TRUST_PROXY: "" }]) {
      const warning = trustProxyStartupWarning(env);
      expect(warning, JSON.stringify(env)).toMatch(/AUTH_TRUST_PROXY is not 1 in production/);
      expect(warning).toMatch(/per e-mail/);
    }
  });

  it("says nothing when the proxy is trusted, and outside production (development and test start quietly)", () => {
    expect(trustProxyStartupWarning({ NODE_ENV: "production", AUTH_TRUST_PROXY: "1" })).toBeNull();
    expect(trustProxyStartupWarning({ NODE_ENV: "development" })).toBeNull();
    expect(trustProxyStartupWarning({ NODE_ENV: "test" })).toBeNull();
    expect(trustProxyStartupWarning({})).toBeNull();
  });
});
