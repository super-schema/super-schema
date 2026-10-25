import { describe, expect, it } from "vitest";
import { DEFAULT_AFTER_LOGIN, safeCallbackUrl } from "@/lib/safe-callback-url";

describe("safeCallbackUrl: where the login page may send a user after signing in", () => {
  it("returns a path of this site as it is (path, query and hash)", () => {
    expect(safeCallbackUrl("/admin/settings")).toBe("/admin/settings");
    expect(safeCallbackUrl("/schemas/billing/ledger?tab=apis&x=1")).toBe("/schemas/billing/ledger?tab=apis&x=1");
    expect(safeCallbackUrl("/schemas/billing#fields")).toBe("/schemas/billing#fields");
    expect(safeCallbackUrl("/schemas/a%20b")).toBe("/schemas/a%20b");
    expect(safeCallbackUrl("/")).toBe("/");
  });

  it.each([
    ["a protocol-relative URL", "//evil.com"],
    ["a protocol-relative URL with a path", "//evil.com/schemas"],
    ["a backslash host", "/\\evil.com"],
    ["a backslash anywhere", "/schemas\\..\\x"],
    ["an absolute https URL", "https://evil.com"],
    ["an absolute http URL of this host", "http://localhost:3000/schemas"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["an encoded protocol-relative URL", "%2F%2Fevil.com"],
    ["an encoded backslash host", "/%5Cevil.com"],
    ["an encoded slash after the first", "/%2Fevil.com"],
    ["a path that normalises to a protocol-relative URL", "/..//evil.com"],
    ["a dot segment that normalises to a protocol-relative URL", "/.//evil.com"],
    ["a tab inside the slashes (browsers drop it)", "/\t/evil.com"],
    ["a newline", "/schemas\n/x"],
    ["a NUL", "/schemas\u0000"],
    ["a malformed percent escape", "/%E0%A4%A"],
    ["a relative path without the leading slash", "schemas"],
    ["whitespace before the slash", " /schemas"],
  ])("falls back to the dashboard for %s", (_name, value) => {
    expect(safeCallbackUrl(value)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("falls back for an empty, missing, non-string or array-valued parameter", () => {
    expect(safeCallbackUrl("")).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(null)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(undefined)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(42)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl({ toString: () => "/schemas" })).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(["/schemas", "/admin"])).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(["/schemas"])).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("falls back for a very long value", () => {
    expect(safeCallbackUrl(`/schemas/${"a".repeat(3000)}`)).toBe(DEFAULT_AFTER_LOGIN);
    expect(safeCallbackUrl(`/schemas/${"a".repeat(1000)}`)).toBe(`/schemas/${"a".repeat(1000)}`);
  });

  it.each([
    "/login",
    "/login/",
    "/login?callbackUrl=%2Fschemas",
    "/login?callbackUrl=/login?callbackUrl=/admin",
    "/Login",
    "/register",
    "/register?x=1",
    "/api/auth/signout",
    "/api/domains-tree",
    "/api",
  ])("falls back for %s (a sign-in loop, or an endpoint that is not a page)", (value) => {
    expect(safeCallbackUrl(value)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("does not take a page whose name only starts like the excluded ones", () => {
    expect(safeCallbackUrl("/loginhelp")).toBe("/loginhelp");
    expect(safeCallbackUrl("/schemas/login")).toBe("/schemas/login");
  });
});

/**
 * The value that is RETURNED is what the browser is sent to, and a router or a proxy may decode a path once before it uses it. So the invariant
 * is on the result: after a percent-decoding (and two more), it still starts with exactly one `/`, with no backslash and no control character.
 * `/./%2fevil.com` normalises to `/%2fevil.com`, whose single decoding is `//evil.com`: the first checks looked at the raw input and at the
 * normalised result without decoding it (the final review found 31 such inputs by fuzzing).
 */
describe("safeCallbackUrl: the returned value stays a path of this site after percent-decoding", () => {
  const decodeOnce = (s: string): string | null => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  /** The decoded forms of a value, up to three rounds (stops where the text cannot be decoded further). */
  const decodedForms = (s: string): string[] => {
    const forms: string[] = [];
    let current = s;
    for (let i = 0; i < 3; i++) {
      const next = decodeOnce(current);
      if (next === null) break;
      forms.push(next);
      current = next;
    }
    return forms;
  };

  it.each([
    ["a dot segment before an encoded slash", "/./%2fevil.com"],
    ["a dot-dot segment before an encoded slash", "/../%2fevil.com"],
    ["a dot segment before an upper-case encoded slash", "/./%2Fevil.com"],
    ["two dot-dot segments before an encoded slash", "/../../%2fevil.com"],
    ["a dot segment before an encoded backslash", "/./%5cevil.com"],
    ["a dot-dot segment before an encoded backslash", "/../%5Cevil.com"],
    ["a dot segment before a double-encoded slash", "/./%252fevil.com"],
    ["a dot segment before a triple-encoded slash", "/./%25252fevil.com"],
    ["an encoded dot segment before an encoded slash", "/%2e/%2fevil.com"],
    ["a double-encoded slash", "/%252fevil.com"],
    ["a double-encoded backslash", "/%255cevil.com"],
    ["a triple-encoded slash", "/%25252fevil.com"],
    ["a path that decodes to a control character", "/schemas/%0a"],
    ["a path that decodes to a backslash", "/schemas/a%5cb"],
    ["a path that decodes to a NUL", "/schemas/%00"],
  ])("falls back for %s", (_name, value) => {
    expect(safeCallbackUrl(value)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("still returns a legitimate path that has encoded characters in it", () => {
    expect(safeCallbackUrl("/schemas/a%2Fb")).toBe("/schemas/a%2Fb");
    expect(safeCallbackUrl("/search?q=100%25")).toBe("/search?q=100%25");
    expect(safeCallbackUrl("/schemas/a%20b?x=%2F%2F")).toBe("/schemas/a%20b?x=%2F%2F");
    expect(safeCallbackUrl("/schemas/%E2%9C%93")).toBe("/schemas/%E2%9C%93");
  });

  it("holds the invariant for every combination of the building blocks of such inputs (about 70,000 values)", () => {
    const blocks = ["/", ".", "..", "%2f", "%2F", "%5c", "%5C", "%252f", "%255c", "%2e", "%00", "%0a", "evil.com", "a", "?", "#"];
    let accepted = 0;
    const walk = (prefix: string, depth: number): void => {
      const result = safeCallbackUrl(prefix);
      if (result !== DEFAULT_AFTER_LOGIN) {
        accepted += 1;
        // the result is a path of this site, in its own form and in every decoded form
        expect(result.startsWith("/") && !result.startsWith("//"), `${prefix} -> ${result}`).toBe(true);
        expect(/[\u0000-\u001f\u007f\\]/.test(result), `${prefix} -> ${result}`).toBe(false);
        for (const form of decodedForms(result)) {
          expect(form.startsWith("/") && !form.startsWith("//"), `${prefix} -> ${result} decodes to ${form}`).toBe(true);
          expect(/[\u0000-\u001f\u007f\\]/.test(form), `${prefix} -> ${result} decodes to ${form}`).toBe(false);
        }
      }
      if (depth === 0) return;
      for (const block of blocks) walk(prefix + block, depth - 1);
    };
    for (const start of blocks) walk(`/${start}`, 3);
    expect(accepted).toBeGreaterThan(100); // the walk is not vacuous: plenty of ordinary paths come back
  });
});
