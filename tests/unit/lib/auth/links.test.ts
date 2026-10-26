// @vitest-environment node
/** The one-time links of the administration: the path always, the absolute address only from configuration. */
import { describe, expect, it } from "vitest";
import { inviteLink, publicOrigin, resetLink } from "@/lib/auth/links";

const TOKEN = "A".repeat(43);

describe("publicOrigin", () => {
  it("is the origin of AUTH_URL, then of NEXTAUTH_URL, and nothing when neither is a web address", () => {
    expect(publicOrigin({ AUTH_URL: "https://app.example.test/some/base/" })).toBe("https://app.example.test");
    expect(publicOrigin({ AUTH_URL: " http://localhost:3000 " })).toBe("http://localhost:3000");
    expect(publicOrigin({ NEXTAUTH_URL: "https://next.example.test" })).toBe("https://next.example.test");
    expect(publicOrigin({ AUTH_URL: "https://first.example.test", NEXTAUTH_URL: "https://second.example.test" })).toBe("https://first.example.test");
    expect(publicOrigin({ AUTH_URL: "", NEXTAUTH_URL: "https://second.example.test" })).toBe("https://second.example.test");
    expect(publicOrigin({})).toBeNull();
    expect(publicOrigin({ AUTH_URL: "not a url" })).toBeNull();
    expect(publicOrigin({ AUTH_URL: "javascript:alert(1)" })).toBeNull();
    expect(publicOrigin({ AUTH_URL: "ftp://files.example.test" })).toBeNull();
  });
});

describe("inviteLink / resetLink", () => {
  it("give the page's path and, with an origin configured, the absolute address", () => {
    expect(inviteLink(TOKEN, { AUTH_URL: "https://app.example.test" })).toEqual({ path: `/invite/${TOKEN}`, url: `https://app.example.test/invite/${TOKEN}` });
    expect(resetLink(TOKEN, { AUTH_URL: "https://app.example.test/" })).toEqual({ path: `/reset/${TOKEN}`, url: `https://app.example.test/reset/${TOKEN}` });
  });

  it("give only the path when the server does not know its origin (the page joins its own)", () => {
    expect(inviteLink(TOKEN, {})).toEqual({ path: `/invite/${TOKEN}`, url: null });
    expect(resetLink(TOKEN, {})).toEqual({ path: `/reset/${TOKEN}`, url: null });
  });

  it("can never be made to leave its route by a strange token", () => {
    expect(inviteLink("../admin?x=1#", {}).path).toBe("/invite/..%2Fadmin%3Fx%3D1%23");
  });
});
