/**
 * Encryption at rest for the secrets the app keeps in its database: a Git repository's credential (`GitConfig.authCredential`) and a webhook
 * endpoint's signing secret (`WebhookEndpoint.secret`). No schema change: the column keeps its text, and a sealed value is recognised by its prefix.
 *
 *   enc:v1:<base64url of: 12-byte IV, 16-byte GCM tag, ciphertext>
 *
 * AES-256-GCM. The field's name is bound as additional authenticated data, so a value sealed for one column does not open in another.
 *
 * The key is `SECRETS_ENCRYPTION_KEY` (32 random bytes in base64: `openssl rand -base64 32`) when it is set. When it is not, the key is derived
 * with HKDF-SHA256 from the session secret (`AUTH_SECRET`, else `NEXTAUTH_SECRET`: src/lib/auth-secret.ts), which the app requires anyway. So
 * CHANGING THE SESSION SECRET MAKES THE STORED SECRETS UNREADABLE unless `SECRETS_ENCRYPTION_KEY` is set (docs/auth-ops.md).
 *
 * A value without the prefix is legacy plaintext: it is read as it is, and sealed the next time its value is written (no data migration).
 * Nothing here logs a value: an error or a warning names the variable or the field, never the value.
 *
 * Node-only (`node:crypto`): it must not be imported by the middleware, which runs in the Edge runtime.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { resolveAuthSecret } from "@/lib/auth-secret";

/** The stored fields that are sealed. The name is part of the seal (the additional authenticated data). */
export type SecretField = "GitConfig.authCredential" | "WebhookEndpoint.secret";

type Env = Record<string, string | undefined>;

/** A secret cannot be sealed or opened: no key is configured, the key is malformed, or the stored value does not open. The message is safe to show. */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = "super-schema secrets at rest v1";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The 32-byte key: `SECRETS_ENCRYPTION_KEY` when it is set (an empty value is not set), else HKDF-SHA256 of the session secret.
 * Throws `SecretBoxError` when neither is set, or when the configured key is not 32 bytes of base64.
 */
export function resolveSecretsKey(env: Env = process.env): Buffer {
  const configured = env.SECRETS_ENCRYPTION_KEY?.trim();
  if (configured) {
    if (!BASE64.test(configured) || Buffer.from(configured, "base64").length !== KEY_BYTES) {
      throw new SecretBoxError("SECRETS_ENCRYPTION_KEY must be 32 random bytes in base64 (make one with `openssl rand -base64 32`)");
    }
    return Buffer.from(configured, "base64");
  }
  const sessionSecret = resolveAuthSecret(env);
  if (sessionSecret === undefined) {
    throw new SecretBoxError("no key protects the stored secrets: set SECRETS_ENCRYPTION_KEY, or AUTH_SECRET (NEXTAUTH_SECRET), which the app needs anyway");
  }
  return Buffer.from(hkdfSync("sha256", sessionSecret, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

/** Whether a stored value is sealed (it has the prefix). A value that is not is legacy plaintext. */
export function isSealedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** The value to store for `plaintext` in `field`. Throws `SecretBoxError` when there is no key. */
export function sealSecret(plaintext: string, field: SecretField, env: Env = process.env): string {
  const key = resolveSecretsKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(field, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/**
 * The sealed value of a plain value that an update which does not need the key writes anyway (a webhook endpoint's change of URL, events or
 * active flag). `undefined` when it cannot be sealed, and the plain value then stays as it is: a key problem never blocks such an update
 * (deactivating an endpoint must always go through). With no key that is silent. A key that is set but malformed is logged on one line, naming
 * the variable and the field, never the value.
 */
export function sealLegacySecret(plaintext: string, field: SecretField, env: Env = process.env): string | undefined {
  try {
    return sealSecret(plaintext, field, env);
  } catch {
    // With a key set, sealing can only fail because the key is malformed: a set key is used as it is and never replaced by the session secret.
    if (env.SECRETS_ENCRYPTION_KEY?.trim()) {
      console.warn(`[secrets] ${field} stays in plain text: SECRETS_ENCRYPTION_KEY is not 32 random bytes in base64 (docs/auth-ops.md)`);
    }
    return undefined;
  }
}

/**
 * The plain value of a stored `field` value. A value without the prefix is legacy plaintext and is returned as it is. Throws `SecretBoxError`
 * when a sealed value is malformed, was sealed with another key or for another field, or was changed.
 */
export function openSecret(stored: string, field: SecretField, env: Env = process.env): string {
  if (!isSealedSecret(stored)) return stored;
  const sealed = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new SecretBoxError(`the stored ${field} is malformed`);
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", resolveSecretsKey(env), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(field, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError(
      `the stored ${field} cannot be opened: SECRETS_ENCRYPTION_KEY (or AUTH_SECRET) is not the one it was sealed with, or the value was changed`
    );
  }
}
