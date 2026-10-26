// @vitest-environment node
/**
 * The principal is read once per request. The cache is React's `cache` (scoped to a server render): this file pins what the loader does
 * with it in the three situations it can meet: a server render (memoizes), the plain React of a route handler or a unit test (`cache` does
 * not memoize: every call reads), and a React with no `cache` at all (the loader must still work). In every one a different session user
 * is a different read: the cache is keyed by the user id, so one user's principal can never be handed to another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign, sessionOf, userRow } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

/** React's `cache` as a server render gives it: one result per distinct (primitive) argument list. */
function memoizeByArgs<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const results = new Map<string, R>();
  return (...args: A) => {
    const key = JSON.stringify(args);
    if (!results.has(key)) results.set(key, fn(...args));
    return results.get(key) as R;
  };
}

async function freshLoader(react: "server-render" | "plain" | "no-cache") {
  vi.resetModules();
  vi.doUnmock("react");
  if (react === "server-render") vi.doMock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: memoizeByArgs }));
  if (react === "no-cache") vi.doMock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: undefined }));
  return import("@/lib/access/principal");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(sessionOf("user-1"));
  mocks.prisma.user.findUnique.mockImplementation(async (args: { where: { id: string } }) => userRow([assign.tenant("AUTHOR", "t1")], { id: args.where.id }));
});
afterEach(() => vi.doUnmock("react"));

describe("inside a server render", () => {
  it("reads the user once however many times the principal is asked for", async () => {
    const { getPrincipal } = await freshLoader("server-render");
    const first = await getPrincipal();
    const second = await getPrincipal();
    const third = await getPrincipal();
    expect(first).toMatchObject({ userId: "user-1" });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("never hands one user's principal to another: a different session user is a different read, and a user who signs out is nobody", async () => {
    const { getPrincipal } = await freshLoader("server-render");
    expect(await getPrincipal()).toMatchObject({ userId: "user-1" });
    mocks.auth.mockResolvedValue(sessionOf("user-2"));
    expect(await getPrincipal()).toMatchObject({ userId: "user-2" });
    mocks.auth.mockResolvedValue(null);
    expect(await getPrincipal()).toBeNull();
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("a disabled or missing user is cached as nobody too", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    const { getPrincipal } = await freshLoader("server-render");
    expect(await getPrincipal()).toBeNull();
    expect(await getPrincipal()).toBeNull();
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("outside a server render", () => {
  it("with plain React (a route handler, a unit test) the loader works and simply reads every time", async () => {
    const { getPrincipal } = await freshLoader("plain");
    expect(await getPrincipal()).toMatchObject({ userId: "user-1" });
    expect(await getPrincipal()).toMatchObject({ userId: "user-1" });
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it("with a React that has no `cache` the module still loads and works, with no caching", async () => {
    const { getPrincipal } = await freshLoader("no-cache");
    expect(await getPrincipal()).toMatchObject({ userId: "user-1" });
    expect(await getPrincipal()).toMatchObject({ userId: "user-1" });
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });
});
