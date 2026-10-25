/**
 * `isBlockedIp` and `assertPublicHost` (the SSRF guard of the "From URL" import): the IPv6 forms that carry an IPv4 address in a prefix other than
 * `::ffff:0:0/96`, the documentation ranges, and an error text that does not say whether a name exists on an internal DNS.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { assertPublicHost, isBlockedIp, RefFetchError } from "@/lib/importers/jsonschema-ref-security";

afterEach(() => vi.restoreAllMocks());

describe("isBlockedIp: the ranges that were allowed", () => {
  it.each([
    // RFC 8215 local-use NAT64 (64:ff9b:1::/48): the embedded address is a translation of anything
    "64:ff9b:1::1", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "64:ff9b:1::808:808",
    // IPv4-translated (SIIT, ::ffff:0:0:0/96): the mapped form is ::ffff:a.b.c.d, this one has the 0 group in front
    "::ffff:0:7f00:1", "::ffff:0:10.0.0.1", "::ffff:0:8.8.8.8", "0:0:0:0:ffff:0:808:808",
    // documentation ranges
    "2001:db8::1", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "2001:DB8::", "3fff::1", "3fff:fff:ffff::1",
    "192.0.2.1", "192.0.2.254", "198.51.100.7", "203.0.113.200",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each([
    "192.0.3.1", "198.51.101.1", "203.0.114.1", "198.52.100.1", "2001:db9::1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808",
    "64:ff9c::1", "3ffe::1", "4000::1",
  ])("still allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it("the forms that were already blocked still are", () => {
    for (const ip of ["::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fc00::1", "192.0.0.1"]) expect(isBlockedIp(ip), ip).toBe(true);
  });
});

describe("assertPublicHost: one text for a name that does not resolve and one that resolves to a blocked address", () => {
  const url = new URL("https://internal.corp.example/a");
  const messageOf = async (lookup: () => Promise<string[]>): Promise<string> => {
    try {
      await assertPublicHost(url, lookup);
    } catch (error) {
      expect(error).toBeInstanceOf(RefFetchError);
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };

  it("the text is identical (an attacker learns nothing about the internal DNS)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unresolved = await messageOf(async () => { throw new Error("ENOTFOUND internal.corp.example"); });
    const blocked = await messageOf(async () => ["10.1.2.3"]);
    const empty = await messageOf(async () => []);
    expect(blocked).toBe(unresolved);
    expect(empty).toBe(unresolved);
    expect(unresolved).toBe("host could not be resolved or is blocked by policy");
    expect(unresolved).not.toContain("10.1.2.3");
  });

  it("the specific reason goes to the server log only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await messageOf(async () => ["10.1.2.3"]);
    await messageOf(async () => { throw new Error("ENOTFOUND"); });
    const logged = warn.mock.calls.map((c) => c.join(" "));
    expect(logged[0]).toContain("internal.corp.example");
    expect(logged[0]).toContain("10.1.2.3");
    expect(logged[1]).toContain("internal.corp.example");
    expect(logged[1]).toMatch(/lookup failed/);
  });
});
