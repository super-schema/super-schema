/**
 * Which database the browser suite deletes from: E2E_DATABASE_URL (the release runner's throwaway PostgreSQL) wins, and while it is
 * set a developer's `.env` is not even read; only when it is not set does DATABASE_URL (the shell's, else `.env`'s) apply.
 */
import { describe, expect, it } from "vitest";
import { e2eDatabaseUrl } from "../../e2e/helpers/db";

describe("e2eDatabaseUrl", () => {
  it("prefers E2E_DATABASE_URL over DATABASE_URL", () => {
    const env = { E2E_DATABASE_URL: "postgresql://e2e/throwaway", DATABASE_URL: "postgresql://dev/real" };
    expect(e2eDatabaseUrl(env)).toBe("postgresql://e2e/throwaway");
  });

  it("does not read .env while E2E_DATABASE_URL is set", () => {
    const env: Record<string, string | undefined> = { E2E_DATABASE_URL: "postgresql://e2e/throwaway" };
    e2eDatabaseUrl(env);
    // dotenv would have copied the developer's DATABASE_URL (and the rest of .env) into `env`.
    expect(env).toEqual({ E2E_DATABASE_URL: "postgresql://e2e/throwaway" });
  });

  it("falls back to the DATABASE_URL of the shell, without reading .env", () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: "postgresql://shell/db" };
    expect(e2eDatabaseUrl(env)).toBe("postgresql://shell/db");
    expect(env).toEqual({ DATABASE_URL: "postgresql://shell/db" });
  });

  it("treats an empty E2E_DATABASE_URL as not set", () => {
    expect(e2eDatabaseUrl({ E2E_DATABASE_URL: "", DATABASE_URL: "postgresql://shell/db" })).toBe("postgresql://shell/db");
  });
});
