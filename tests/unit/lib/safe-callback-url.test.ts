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
