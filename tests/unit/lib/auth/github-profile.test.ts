/**
 * GitHub's profile for the sign-in decision (src/lib/auth/github-profile.ts). Auth.js's own look-up takes the profile's public e-mail, then
 * `emails.find(primary) ?? emails[0]`: an address nobody has verified can end up as "the e-mail". This replacement takes ONLY the primary address that
 * GitHub's own e-mail list says is verified, and says so with `email_verified`. No network here: `fetch` is a stub.
 */
import { describe, expect, it, vi } from "vitest";
import { githubVerifiedPrimaryEmailProfile } from "@/lib/auth/github-profile";

function stubFetch(routes: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return vi.fn(async (...args: [string | URL | Request, RequestInit?]) => {
    const route = routes[String(args[0])];
    if (!route) throw new Error(`unexpected request to ${String(args[0])}`);
    return { ok: route.ok ?? true, status: route.status ?? 200, json: async () => structuredClone(route.body) } as Response;
  });
}

const TOKENS = { access_token: "gho_test_token" };
const USER = "https://api.github.com/user";
const EMAILS = "https://api.github.com/user/emails";
const run = (fetchStub: ReturnType<typeof stubFetch>) => githubVerifiedPrimaryEmailProfile({ tokens: TOKENS }, fetchStub as unknown as typeof fetch);

describe("githubVerifiedPrimaryEmailProfile", () => {
  it("takes the primary address that is verified, and marks it verified", async () => {
    const fetchStub = stubFetch({
      [USER]: { body: { id: 7, login: "ada", name: "Ada", email: "public@elsewhere.test", avatar_url: "https://avatars.test/7" } },
      [EMAILS]: {
        body: [
          { email: "other@example.com", primary: false, verified: true },
          { email: "ada@example.com", primary: true, verified: true },
        ],
      },
    });
    const profile = await run(fetchStub);
    expect(profile).toMatchObject({ id: 7, login: "ada", name: "Ada", email: "ada@example.com", email_verified: true });
  });

  it("never uses the public address of the profile (it is not the verified primary one), even when the list cannot be read", async () => {
    const unreadable = stubFetch({ [USER]: { body: { id: 7, login: "ada", email: "public@elsewhere.test" } }, [EMAILS]: { ok: false, status: 403, body: { message: "forbidden" } } });
    const profile = await run(unreadable);
    expect(profile.email).toBeUndefined();
    expect(profile.email_verified).toBeUndefined();
    expect(profile.login).toBe("ada");
  });

  it.each([
    ["the primary address is not verified", [{ email: "ada@example.com", primary: true, verified: false }, { email: "x@example.com", primary: false, verified: true }]],
    ["no address is primary (Auth.js would take the first one)", [{ email: "first@example.com", primary: false, verified: true }]],
    ["the list is empty", []],
    ["the answer is not a list", { message: "Not Found" }],
    ["verified is not the boolean true", [{ email: "ada@example.com", primary: true, verified: "true" }]],
    ["the address is not a text", [{ email: null, primary: true, verified: true }]],
    ["an entry is not an object", [null, "ada@example.com"]],
  ])("gives no e-mail when %s", async (_name, body) => {
    const profile = await run(stubFetch({ [USER]: { body: { id: 7, login: "ada", email: "public@elsewhere.test" } }, [EMAILS]: { body } }));
    expect(profile.email).toBeUndefined();
    expect(profile.email_verified).toBeUndefined();
  });

  it("asks GitHub's API only, with the access token and no other credential", async () => {
    const fetchStub = stubFetch({ [USER]: { body: { id: 7, login: "ada" } }, [EMAILS]: { body: [] } });
    await run(fetchStub);
    expect(fetchStub.mock.calls.map((call) => String(call[0]))).toEqual([USER, EMAILS]);
    for (const call of fetchStub.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers;
      expect(headers.Authorization).toBe("Bearer gho_test_token");
    }
  });
});
