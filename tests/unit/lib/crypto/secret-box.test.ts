import { describe, expect, it, vi } from "vitest";
import { isSealedSecret, openSecret, resolveSecretsKey, sealLegacySecret, sealSecret, SecretBoxError } from "@/lib/crypto/secret-box";

const FIELD = "GitConfig.authCredential";
const PLAIN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const SESSION_SECRET = "s".repeat(40);

/** The stored value, split into its prefix and the base64url body (iv, tag, ciphertext). */
function body(sealed: string): Buffer {
  expect(sealed.startsWith("enc:v1:")).toBe(true);
  return Buffer.from(sealed.slice("enc:v1:".length), "base64url");
}

function withBody(sealed: string, change: (raw: Buffer) => Buffer): string {
  return `enc:v1:${change(body(sealed)).toString("base64url")}`;
}

describe("secret-box: sealing with SECRETS_ENCRYPTION_KEY", () => {
  const env = { SECRETS_ENCRYPTION_KEY: KEY_A };

  it("round-trips a value, and the stored value is not the plain value", () => {
    const sealed = sealSecret(PLAIN, FIELD, env);

    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain(PLAIN);
    expect(openSecret(sealed, FIELD, env)).toBe(PLAIN);
  });

  it("uses a fresh IV every time, so the same value seals differently", () => {
    const first = sealSecret(PLAIN, FIELD, env);
    const second = sealSecret(PLAIN, FIELD, env);

    expect(first).not.toBe(second);
    expect(openSecret(first, FIELD, env)).toBe(PLAIN);
    expect(openSecret(second, FIELD, env)).toBe(PLAIN);
  });

  it("reads a legacy plaintext value (no prefix) as it is, without any key", () => {
    expect(openSecret(PLAIN, FIELD, env)).toBe(PLAIN);
    expect(openSecret(PLAIN, FIELD, {})).toBe(PLAIN);
  });

  it("refuses a tampered ciphertext, a tampered tag and a truncated value", () => {
    const sealed = sealSecret(PLAIN, FIELD, env);
    const flipLastCiphertextByte = withBody(sealed, (raw) => {
      raw[raw.length - 1] ^= 0x01;
      return raw;
    });
    const flipTagByte = withBody(sealed, (raw) => {
      raw[12] ^= 0x01;
      return raw;
    });
    const truncated = `enc:v1:${body(sealed).subarray(0, 10).toString("base64url")}`;

    for (const tampered of [flipLastCiphertextByte, flipTagByte, truncated]) {
      let caught: unknown;
      try {
        openSecret(tampered, FIELD, env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretBoxError);
      expect((caught as Error).message).not.toContain(PLAIN);
    }
  });

  it("refuses to open with a different key, and the error carries neither key nor value", () => {
    const sealed = sealSecret(PLAIN, FIELD, env);
    let caught: unknown;
    try {
      openSecret(sealed, FIELD, { SECRETS_ENCRYPTION_KEY: KEY_B });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SecretBoxError);
    const message = (caught as Error).message;
    expect(message).toContain("cannot be opened");
    expect(message).not.toContain(PLAIN);
    expect(message).not.toContain(KEY_B);
    expect(message).not.toContain(sealed);
  });

  it("binds the value to its field: a value sealed for one column does not open in another", () => {
    const sealed = sealSecret(PLAIN, FIELD, env);

    expect(() => openSecret(sealed, "WebhookEndpoint.secret", env)).toThrow(SecretBoxError);
  });

  it("accepts a key with surrounding whitespace, as a secret file or a shell export may leave one", () => {
    const sealed = sealSecret(PLAIN, FIELD, env);

    expect(openSecret(sealed, FIELD, { SECRETS_ENCRYPTION_KEY: `  ${KEY_A}\n` })).toBe(PLAIN);
  });

  it("refuses a key that is not 32 bytes of base64, without showing it", () => {
    for (const bad of ["not-a-key!", Buffer.alloc(16, 3).toString("base64"), "abc"]) {
      let caught: unknown;
      try {
        resolveSecretsKey({ SECRETS_ENCRYPTION_KEY: bad });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretBoxError);
      expect((caught as Error).message).toContain("32 random bytes");
      expect((caught as Error).message).not.toContain(bad);
    }
  });

  it("refuses a malformed stored value", () => {
    expect(() => openSecret("enc:v1:AAAA", FIELD, env)).toThrow(SecretBoxError);
  });

  it("tells a sealed value from a legacy plain one by the prefix alone", () => {
    expect(isSealedSecret(sealSecret(PLAIN, FIELD, env))).toBe(true);
    expect(isSealedSecret(PLAIN)).toBe(false);
  });
});

describe("secret-box: the key derived from the session secret when SECRETS_ENCRYPTION_KEY is not set", () => {
  it("round-trips with AUTH_SECRET alone, and the derived key is 32 bytes", () => {
    const env = { AUTH_SECRET: SESSION_SECRET };
    const sealed = sealSecret(PLAIN, FIELD, env);

    expect(resolveSecretsKey(env)).toHaveLength(32);
    expect(openSecret(sealed, FIELD, env)).toBe(PLAIN);
  });

  it("is the same key for the same session secret, and a different one after the session secret changes", () => {
    const sealed = sealSecret(PLAIN, FIELD, { AUTH_SECRET: SESSION_SECRET });

    expect(resolveSecretsKey({ AUTH_SECRET: SESSION_SECRET }).equals(resolveSecretsKey({ AUTH_SECRET: SESSION_SECRET }))).toBe(true);
    // The coupling the docs describe: rotating AUTH_SECRET without SECRETS_ENCRYPTION_KEY makes the stored values unreadable.
    expect(() => openSecret(sealed, FIELD, { AUTH_SECRET: "t".repeat(40) })).toThrow(SecretBoxError);
  });

  it("uses NEXTAUTH_SECRET when AUTH_SECRET is not set, and treats an empty AUTH_SECRET as not set", () => {
    const sealed = sealSecret(PLAIN, FIELD, { NEXTAUTH_SECRET: SESSION_SECRET });

    expect(openSecret(sealed, FIELD, { AUTH_SECRET: "", NEXTAUTH_SECRET: SESSION_SECRET })).toBe(PLAIN);
  });

  it("the configured key decouples the stored values from the session secret", () => {
    const sealed = sealSecret(PLAIN, FIELD, { SECRETS_ENCRYPTION_KEY: KEY_A, AUTH_SECRET: SESSION_SECRET });

    expect(openSecret(sealed, FIELD, { SECRETS_ENCRYPTION_KEY: KEY_A, AUTH_SECRET: "t".repeat(40) })).toBe(PLAIN);
  });
});

describe("secret-box: a legacy value written by an update that does not need the key", () => {
  it("seals it when the key is valid", () => {
    const env = { SECRETS_ENCRYPTION_KEY: KEY_A };
    const sealed = sealLegacySecret(PLAIN, FIELD, env);

    expect(sealed).toBeDefined();
    expect(openSecret(sealed as string, FIELD, env)).toBe(PLAIN);
  });

  it("returns nothing and stays silent when no key is set: the legacy value stays as it is", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(sealLegacySecret(PLAIN, FIELD, { AUTH_SECRET: "" })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns nothing and logs one line when the key is set but malformed: the line names the variable and the field, never the value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(sealLegacySecret(PLAIN, FIELD, { SECRETS_ENCRYPTION_KEY: "not-a-key!" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("SECRETS_ENCRYPTION_KEY");
    expect(line).toContain(FIELD);
    expect(line).not.toContain("not-a-key!");
    expect(line).not.toContain(PLAIN);
    warn.mockRestore();
  });
});

describe("secret-box: no key at all", () => {
  it("refuses to seal, and names the variables to set", () => {
    let caught: unknown;
    try {
      sealSecret(PLAIN, FIELD, {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SecretBoxError);
    expect((caught as Error).message).toContain("SECRETS_ENCRYPTION_KEY");
    expect((caught as Error).message).not.toContain(PLAIN);
  });

  it("an empty SECRETS_ENCRYPTION_KEY is not set", () => {
    expect(() => sealSecret(PLAIN, FIELD, { SECRETS_ENCRYPTION_KEY: "", AUTH_SECRET: "" })).toThrow(SecretBoxError);
  });
});
