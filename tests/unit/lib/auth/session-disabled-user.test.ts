// @vitest-environment node
/**
 * A user disabled AFTER signing in is refused on the next request, with the very session token they were given. This crosses the layers with a REAL
 * token (minted with Auth.js's own `encode`, the secret and salt the middleware reads): the middleware still accepts the cookie (a session is a
 * signed token; nothing on the server ends it), and the principal loader, which decides who a request is from the session's user id and the user
 * row, answers "nobody" the moment `disabledAt` is set. The session's lifetime is 12 hours (tests/unit/lib/auth/auth-config.test.ts), so this is the
 * layer that makes a disable immediate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decode, encode } from "next-auth/jwt";
import { assign, userRow } from "../../../helpers/access-mocks";

const SECRET = "session-disabled-user-secret-0123456789";
const COOKIE_NAME = "authjs.session-token";
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), cookie: { value: "" } }));

vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
// `auth()` of the app, standing in for Auth.js: it reads the same cookie and decodes it with the same secret and salt, which is what Auth.js does.
vi.mock("@/lib/auth", () => ({
  auth: async () => {
    const token = await decode({ token: mocks.cookie.value, secret: SECRET, salt: COOKIE_NAME });
    return token?.sub ? { user: { id: token.sub, email: token.email }, expires: "2999-01-01" } : null;
  },
}));

import { middleware } from "@/middleware";
import { getPrincipal } from "@/lib/access/principal";

let saved: { AUTH_SECRET?: string; NEXTAUTH_SECRET?: string };
beforeAll(() => {
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET };
  process.env.AUTH_SECRET = SECRET;
  delete process.env.NEXTAUTH_SECRET;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let cookieHeader: string;
beforeEach(async () => {
  vi.clearAllMocks();
  const token = await encode({ token: { sub: "user-1", email: "user@example.test" }, secret: SECRET, salt: COOKIE_NAME, maxAge: 12 * 60 * 60 });
  mocks.cookie.value = token;
  cookieHeader = `${COOKIE_NAME}=${token}`;
});

const asksFor = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`, { headers: { cookie: cookieHeader } }));

describe("a user disabled after signing in", () => {
  it("is let through the door and known to the loader while active, and the SAME token is nobody once disabled", async () => {
    mocks.findUnique.mockResolvedValue(userRow([assign.tenant("AUTHOR", "t1")]));
    expect((await asksFor("/schemas")).headers.get("location")).toBeNull();
    expect(await getPrincipal()).toMatchObject({ userId: "user-1", email: "user@example.test", assignments: [{ role: "AUTHOR" }] });

    // An administrator disables the account. Nothing touches the session cookie.
    mocks.findUnique.mockResolvedValue(userRow([assign.tenant("AUTHOR", "t1")], { disabledAt: new Date() }));

    // The cookie is still a valid session for the middleware (it cannot know) ...
    expect((await asksFor("/schemas")).headers.get("location")).toBeNull();
    // ... and the principal loader, which every guard asks, says nobody.
    expect(await getPrincipal()).toBeNull();
    expect(mocks.findUnique).toHaveBeenLastCalledWith({ where: { id: "user-1" }, select: expect.objectContaining({ disabledAt: true }) });
  });

  it("is nobody too when the account is deleted, and is again somebody only through the user row, never through the e-mail in the token", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await getPrincipal()).toBeNull();
    // The e-mail in the token is not a way back in: the loader asked for the id, once, and nothing else.
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: "user-1" } });
  });
});
