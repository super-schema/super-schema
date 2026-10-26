/**
 * The password rule and the e-mail rule of every way an account gets a password: registration, accepting an invitation, a reset link
 * (access-control design, decision 8). Pure: no I/O, no throws.
 *
 * Length is counted in BYTES of the UTF-8 form, 12 to 72: bcrypt reads at most 72 bytes of a password and ignores the rest, so a longer one
 * would be silently cut (a person who typed 80 bytes would be signing in with the first 72), and `ü` costs two bytes, an emoji four. The deny-list
 * (src/lib/auth/common-passwords.ts) refuses the trivial: common passwords and their disguises, one character or one short unit repeated, a plain
 * run, and the user's e-mail address and the name in front of the `@`.
 */
import { isCommonPassword } from "@/lib/auth/common-passwords";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES } from "@/lib/auth/password-limits";

export { PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES };

/** An e-mail address as it is stored and compared: trimmed and lower-cased (the database's unique index is on `lower(email)`). Anything that is not a string is "". */
export function normalizeEmail(raw: string): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** The shortest name in front of the `@` that is refused inside a password (a two-letter name would refuse half the alphabet). */
const MIN_LOCAL_PART_LENGTH = 4;
/** The longest unit that, repeated through the whole password, makes it "one pattern repeated" (`abab...`, `123123...`, `abcdabcd...`). */
const MAX_REPEAT_UNIT = 4;

const EASY = "That password is too easy to guess";

/** The whole password is one unit of up to four characters, repeated at least three times. Works on characters (code points), not UTF-16 halves. */
function isRepeatedUnit(chars: readonly string[]): boolean {
  for (let unit = 1; unit <= MAX_REPEAT_UNIT; unit++) {
    if (chars.length < unit * 3 || chars.length % unit !== 0) continue;
    let repeats = true;
    for (let i = unit; i < chars.length; i++) {
      if (chars[i] !== chars[i - unit]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

/** The whole password is a plain run: each character one code point after (or before) the one in front (`abcdefghijkl`, `zyxw...`), or numerals counting up or down around the 9-0 corner (`123456789012`). */
function isPlainRun(chars: readonly string[]): boolean {
  if (chars.length < 6) return false;
  const points = chars.map((char) => char.codePointAt(0) ?? 0);
  const steps = points.slice(1).map((point, i) => point - points[i]);
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) return true;
  if (points.every((point) => point >= 48 && point <= 57)) {
    const modular = steps.map((step) => ((step % 10) + 10) % 10);
    return modular.every((step) => step === 1) || modular.every((step) => step === 9);
  }
  return false;
}

/**
 * Is `raw` an acceptable password? `context.email` (the address the account has or is being made for) widens the deny-list to the address itself
 * and to the name in front of its `@`. The message is shown to the person who typed the password, so it says what to change.
 */
export function validatePassword(raw: string, context?: { email?: string }): { ok: true } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter a password." };

  const bytes = byteLength(raw);
  if (bytes < PASSWORD_MIN_BYTES) {
    return { ok: false, message: `The password must be at least ${PASSWORD_MIN_BYTES} bytes (it is ${bytes}). A passphrase of a few words is easy to remember and hard to guess.` };
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    return {
      ok: false,
      message: `The password must be at most ${PASSWORD_MAX_BYTES} bytes (it is ${bytes}): the hash reads no more than that, so the rest would not count. Accented letters and emoji take two to four bytes each.`,
    };
  }

  const chars = Array.from(raw);
  if (isRepeatedUnit(chars)) return { ok: false, message: `${EASY}: it is one character or pattern repeated.` };
  if (isPlainRun(chars)) return { ok: false, message: `${EASY}: it is a plain sequence.` };
  if (isCommonPassword(raw)) return { ok: false, message: `${EASY}. Choose a longer or less common one.` };

  const email = normalizeEmail(context?.email ?? "");
  if (email !== "") {
    const lower = raw.toLowerCase();
    const localPart = email.split("@")[0] ?? "";
    if (lower === email || (localPart.length >= MIN_LOCAL_PART_LENGTH && lower.includes(localPart))) {
      return { ok: false, message: "The password must not contain your e-mail address or the name in front of the @." };
    }
  }
  return { ok: true };
}
