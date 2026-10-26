/**
 * The session secret (src/lib/auth-secret.ts): the middleware and Auth.js must read the same one (an empty name is not set), and a
 * production server refuses to start with a missing, short or known development secret. Development and test are never affected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PRODUCTION_SECRET_LENGTH, assertProductionAuthSecret, productionSecretProblem, resolveAuthSecret } from "@/lib/auth-secret";
import { refuseToStartWithoutProductionSecret } from "@/lib/auth-secret-startup";

const STRONG = "k3Jx9aP0Qm7Vb2Lr5Tz8Wd1Yn4Hc6Gf0Se3Uo9Ai2Bm="; // 44 characters, what `openssl rand -base64 32` looks like

describe("resolveAuthSecret: AUTH_SECRET, else NEXTAUTH_SECRET, an empty name is not set", () => {
  it("prefers AUTH_SECRET (the name Auth.js documents)", () => {
    expect(resolveAuthSecret({ AUTH_SECRET: "a", NEXTAUTH_SECRET: "n" })).toBe("a");
  });

  it("falls back to NEXTAUTH_SECRET when AUTH_SECRET is unset", () => {
    expect(resolveAuthSecret({ NEXTAUTH_SECRET: "n" })).toBe("n");
  });

  it("treats an EMPTY AUTH_SECRET as unset: Auth.js's `??` stopped at it and signed with nothing while the middleware went on to NEXTAUTH_SECRET", () => {
    expect(resolveAuthSecret({ AUTH_SECRET: "", NEXTAUTH_SECRET: "n" })).toBe("n");
    expect(resolveAuthSecret({ AUTH_SECRET: "a", NEXTAUTH_SECRET: "" })).toBe("a");
  });

  it("is undefined when neither is set or both are empty (the middleware fails closed, and so does a production start)", () => {
    expect(resolveAuthSecret({})).toBeUndefined();
    expect(resolveAuthSecret({ AUTH_SECRET: "", NEXTAUTH_SECRET: "" })).toBeUndefined();
  });

  it("does NOT read Auth.js's rotation names: AUTH_SECRET_1..3 alone is no secret here", () => {
    expect(resolveAuthSecret({ AUTH_SECRET_1: "x", AUTH_SECRET_2: "y", AUTH_SECRET_3: "z" })).toBeUndefined();
  });

  it("reads process.env by default", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "from-process-env");
    expect(resolveAuthSecret()).toBe("from-process-env");
    vi.unstubAllEnvs();
  });
});

describe("productionSecretProblem", () => {
  it("accepts a strong secret (openssl rand -base64 32 and -hex 32 shapes)", () => {
    expect(productionSecretProblem(STRONG)).toBeNull();
    expect(productionSecretProblem("0".repeat(2) + "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBeNull();
  });

  it("refuses a missing secret and says that the rotation names are not enough", () => {
    const problem = productionSecretProblem(undefined) as string;
    expect(problem).toContain("no session secret is set");
    expect(problem).toContain("AUTH_SECRET_1..3");
    expect(problem).toContain("openssl rand -base64 32");
  });

  it(`refuses a secret shorter than ${MIN_PRODUCTION_SECRET_LENGTH} characters, naming the length and how to generate one`, () => {
    const problem = productionSecretProblem("x".repeat(31)) as string;
    expect(problem).toContain("31 characters");
    expect(problem).toContain(`production needs at least ${MIN_PRODUCTION_SECRET_LENGTH}`);
    expect(problem).toContain("openssl rand -base64 32");
    expect(productionSecretProblem("x".repeat(MIN_PRODUCTION_SECRET_LENGTH))).toBeNull();
  });

  it("refuses the known development values whatever their length: the compose file's, .env.example's, and the usual ones, in any case", () => {
    for (const value of [
      "dev-secret-change-in-production", // 31: the compose file's, short and known
      "your-secret-here",
      "secret",
      "changeme",
      "CHANGEME",
      "  Secret  ",
      "password",
      "supersecret",
      "my-secret",
      "dev-auth-secret",
    ]) {
      expect(productionSecretProblem(value), value).toContain("known development value");
    }
  });

  it("refuses a placeholder even when it is long enough (it says to change it)", () => {
    for (const value of ["please-change-me-before-you-deploy-this", "dev-secret-change-in-production-please-do", "your-secret-here-your-secret-here-1234", "replace_me_with_a_real_secret_value_12345"]) {
      expect(productionSecretProblem(value), value).toContain("known development value or a placeholder");
    }
  });

  it("does not print a long refused secret in full", () => {
    const secret = `change-me-${"x".repeat(60)}`;
    expect(productionSecretProblem(secret)).not.toContain(secret);
  });
});

describe("assertProductionAuthSecret", () => {
  const production = { NODE_ENV: "production" };

  it("throws in production for a weak or missing secret, with 'Refusing to start in production' and how to make one", () => {
    expect(() => assertProductionAuthSecret({ ...production, NEXTAUTH_SECRET: "dev-secret-change-in-production" })).toThrow(/Refusing to start in production: the session secret is a known development value/);
    expect(() => assertProductionAuthSecret({ ...production, AUTH_SECRET: "short" })).toThrow(/5 characters/);
    expect(() => assertProductionAuthSecret({ ...production })).toThrow(/no session secret is set/);
    expect(() => assertProductionAuthSecret({ ...production, NEXTAUTH_SECRET: "x" })).toThrow(/openssl rand -base64 32/);
  });

  it("judges the EFFECTIVE secret: a strong AUTH_SECRET wins over a weak NEXTAUTH_SECRET (Auth.js and the middleware read AUTH_SECRET first)", () => {
    expect(() => assertProductionAuthSecret({ ...production, AUTH_SECRET: STRONG, NEXTAUTH_SECRET: "dev-secret-change-in-production" })).not.toThrow();
    // an empty AUTH_SECRET is not the effective one: NEXTAUTH_SECRET is, and it is weak
    expect(() => assertProductionAuthSecret({ ...production, AUTH_SECRET: "", NEXTAUTH_SECRET: "secret" })).toThrow(/known development value/);
  });

  it("accepts a strong secret in production", () => {
    expect(() => assertProductionAuthSecret({ ...production, NEXTAUTH_SECRET: STRONG })).not.toThrow();
    expect(() => assertProductionAuthSecret({ ...production, AUTH_SECRET: STRONG })).not.toThrow();
  });

  it("never throws outside production: development and test keep their short secrets", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => assertProductionAuthSecret({ NODE_ENV, NEXTAUTH_SECRET: "your-secret-here" })).not.toThrow();
      expect(() => assertProductionAuthSecret({ NODE_ENV })).not.toThrow();
    }
  });
});

describe("refuseToStartWithoutProductionSecret: the process ends, it does not stay up answering 500", () => {
  // A hook of Next that throws leaves `next start` listening and answering 500 to every request (seen with a real build): the process stays
  // alive, an orchestrator that restarts on exit never sees one, and a health check that only opens the port passes. So the refusal ends the process.
  const run = (env: Record<string, string | undefined>) => {
    const written: string[] = [];
    const exits: number[] = [];
    refuseToStartWithoutProductionSecret(env, {
      write: (text, done) => {
        written.push(text);
        done();
      },
      exit: (code) => void exits.push(code),
    });
    return { written, exits };
  };

  it("writes the reason, then exits with code 1, for a weak or missing secret in production", () => {
    for (const env of [{ NODE_ENV: "production", NEXTAUTH_SECRET: "dev-secret-change-in-production" }, { NODE_ENV: "production", AUTH_SECRET: "short" }, { NODE_ENV: "production" }]) {
      const { written, exits } = run(env);
      expect(written.join(""), JSON.stringify(env)).toContain("Refusing to start in production:");
      expect(written.join("")).toContain("openssl rand -base64 32");
      expect(exits).toEqual([1]);
    }
  });

  it("does nothing for a strong secret in production, and for development and test whatever the secret", () => {
    for (const env of [{ NODE_ENV: "production", AUTH_SECRET: STRONG }, { NODE_ENV: "development", NEXTAUTH_SECRET: "secret" }, { NODE_ENV: "test" }, {}]) {
      expect(run(env), JSON.stringify(env)).toEqual({ written: [], exits: [] });
    }
  });

  it("exits only after the message was flushed (a process.exit right after an asynchronous write can lose it)", () => {
    const order: string[] = [];
    let flush: () => void = () => {};
    refuseToStartWithoutProductionSecret(
      { NODE_ENV: "production" },
      {
        write: (_text, done) => {
          order.push("write");
          flush = done;
        },
        exit: () => void order.push("exit"),
      },
    );
    expect(order).toEqual(["write"]);
    flush();
    expect(order).toEqual(["write", "exit"]);
  });
});

describe("src/env.ts: the same rule in the schema", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a weak secret in production (the validation names the reason)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", "dev-secret-change-in-production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(import("@/env")).rejects.toThrow(/Invalid environment variables/);
    expect(JSON.stringify(error.mock.calls)).toContain("known development value");
  });

  it("accepts a strong secret in production, and any non-empty one in development and test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG);
    expect((await import("@/env")).env.NEXTAUTH_SECRET).toBe(STRONG);
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_SECRET", "your-secret-here");
    expect((await import("@/env")).env.NEXTAUTH_SECRET).toBe("your-secret-here");
  });
});
