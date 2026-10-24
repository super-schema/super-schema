/**
 * What the setup project saves of the admin's login, and where: cookies only (a saved `localStorage` makes "the app stores X"
 * assertions pass by themselves), in the file `E2E_AUTH_STATE` names when it is set (two runs at once must not share one file).
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookiesOnly } from "../../e2e/helpers/auth-state";

describe("cookiesOnly", () => {
  it("keeps the cookies and drops every origin's storage", () => {
    const state = {
      cookies: [{ name: "authjs.session-token", value: "abc", domain: "localhost", path: "/" }],
      origins: [{ origin: "http://localhost:3000", localStorage: [{ name: "panel-width-left-sidebar", value: "320" }] }],
    };
    expect(cookiesOnly(state)).toEqual({ cookies: state.cookies, origins: [] });
  });

  it("is fine with a state that has no origins", () => {
    expect(cookiesOnly({ cookies: [] })).toEqual({ cookies: [], origins: [] });
  });
});

describe("AUTH_STATE_PATH", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is playwright/.auth/admin.json of the repository by default", async () => {
    vi.stubEnv("E2E_AUTH_STATE", "");
    vi.resetModules();
    const { AUTH_STATE_PATH } = await import("../../e2e/helpers/auth-state");
    expect(AUTH_STATE_PATH).toBe(path.resolve(__dirname, "../../../playwright/.auth/admin.json"));
  });

  it("is the file E2E_AUTH_STATE names, a relative one from the working directory", async () => {
    vi.stubEnv("E2E_AUTH_STATE", "tmp/run-7/admin.json");
    vi.resetModules();
    const { AUTH_STATE_PATH } = await import("../../e2e/helpers/auth-state");
    expect(AUTH_STATE_PATH).toBe(path.resolve(process.cwd(), "tmp/run-7/admin.json"));
  });
});
