// src/lib/audit-redaction.ts
// Keeps credentials out of the immutable audit trail: shared by every audit writer (withAudit, recordAuditFailure, auditInTransaction).
import { Prisma } from "@/generated/prisma/client";

/**
 * Key names that say a value is a credential, after lower-casing and dropping `_` and `-` (`apiKey`, `api_key`, `API-KEY` are one name).
 * A key counts when its name ENDS with one of these: `authCredential`, `clientSecret`, `accessToken`, `privateKey`, `secretAccessKey`. The
 * plural forms count too: `credentials`, `apiKeys`.
 */
const CREDENTIAL_KEY_SUFFIXES = [
  "credential",
  "credentials",
  "secret",
  "secrets",
  "secretkey",
  "secretkeys",
  "password",
  "passwords",
  "token",
  "tokens",
  "apikey",
  "apikeys",
  "privatekey",
  "privatekeys",
  "accesskey",
  "accesskeys",
] as const;
const REDACTED = "[redacted]";

const isCredentialKey = (key: string): boolean => {
  const name = key.toLowerCase().replace(/[-_]/g, "");
  return CREDENTIAL_KEY_SUFFIXES.some((suffix) => name.endsWith(suffix));
};

/**
 * A copy of an audit state in which the text, or the list or object, under every credential-looking key is `[redacted]`, at any depth. Defence
 * in depth: the audit trail is immutable (the audit_log trigger refuses UPDATE and DELETE), so a credential written into it can never be
 * removed. The callers already record projections without credentials; this is what keeps one from getting in by mistake. A boolean, a number
 * or a null under such a key stays: `secret: true` is the TypeSpec `@secret` decorator and `maxTokens: 2048` a model setting, neither a
 * credential. A date and a buffer are kept as they are. Anything else is searched in the form it is written in, its JSON form when it has one
 * (a class with its own `toJSON` is no way past the check; a decimal or a URL becomes its string). The state passed in is not changed.
 */
export function redactCredentials(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return state;
  if (state instanceof Date || Buffer.isBuffer(state)) return state;
  // Prisma's null sentinels are not data: the write needs the sentinel itself, so it is kept as it is.
  if (state === Prisma.JsonNull || state === Prisma.DbNull || state === Prisma.AnyNull) return state;
  const json: unknown =
    typeof (state as { toJSON?: unknown }).toJSON === "function" ? (state as { toJSON(): unknown }).toJSON() : state;
  if (typeof json !== "object" || json === null) return json;
  if (Array.isArray(json)) return json.map((item) => redactCredentials(item));
  return Object.fromEntries(
    Object.entries(json).map(([key, value]) => {
      const credential = isCredentialKey(key) && (typeof value === "string" || (typeof value === "object" && value !== null));
      return [key, credential ? REDACTED : redactCredentials(value)];
    })
  );
}
