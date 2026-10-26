/**
 * Hashing and checking a password (bcrypt, the library every existing hash was made with).
 *
 * `verifyPassword` ALWAYS runs a bcrypt compare. For an account that does not exist, one without a password (made by Google) or a stored value
 * that is not a bcrypt hash, the compare runs against `DUMMY_PASSWORD_HASH`, a cost-12 hash of a random string that was thrown away, and the answer
 * is false. A sign-in for an unknown e-mail therefore costs what one for a known e-mail costs, and the time does not tell a visitor which
 * addresses have an account (access-control design, decision 8).
 *
 * Cost 12 is what `registerAction`, the seed and `admin:create` have always used, about 300 ms of CPU; bcrypt stores its cost inside the hash,
 * so a hash made at another cost (or with the `$2a$` / `$2y$` prefix) verifies unchanged. Hashes are not re-made at login: that would need a
 * decision about the cost that this task does not take.
 */
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;

/**
 * A valid bcrypt hash, at the cost of every real one, of a random 192-bit string that nobody holds. Only ever compared against.
 * (Made once with `bcrypt.hash(randomBytes(24).toString("base64url"), 12)`; a unit test checks its shape and cost.)
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$2b3bW/ywfwlFw8yeGgFMHuxfheXwx.aJRz5e3VAnBIUuTJAhH9Vne";

/** bcrypt reads 72 bytes, and a UTF-8 character is at most 4 bytes, so the first 72 characters already cover every byte that counts; a larger bound only avoids copying a huge form field. */
const MAX_COMPARED_CHARACTERS = 1024;

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/** The bcrypt hash of a password, at cost 12. The caller has already applied the password policy (src/lib/auth/password-policy.ts); this does not. */
export async function hashPassword(raw: string): Promise<string> {
  return bcrypt.hash(raw, BCRYPT_COST);
}

/**
 * Does `raw` match the stored hash? Always one bcrypt compare, against `stored` when it is a bcrypt hash and against the dummy otherwise, and then
 * false. Never throws for a password that is not a string or a stored value that is not a hash.
 *
 * @param raw the password as typed
 * @param stored the account's `User.password`, or null / undefined / "" for no account or no password
 */
export async function verifyPassword(raw: string, stored: string | null | undefined): Promise<boolean> {
  const known = typeof stored === "string" && BCRYPT_HASH.test(stored);
  const typed = typeof raw === "string" ? raw.slice(0, MAX_COMPARED_CHARACTERS) : "";
  const matches = await bcrypt.compare(typed, known ? stored : DUMMY_PASSWORD_HASH);
  // For a non-string password the answer is false whatever the hash says: it is not a password anyone typed.
  return known && typeof raw === "string" && matches;
}
