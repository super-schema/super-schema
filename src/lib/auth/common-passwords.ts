/**
 * The deny-list of the password policy (src/lib/auth/password-policy.ts): small on purpose, and real. It is not a breach corpus; it stops the
 * passwords that a length rule alone lets through, because they are 12 characters or more and still the first thing anyone tries:
 * `password1234`, `123456789012`, `qwertyuiop12`, and the same few words in their usual disguises (`P@ssw0rd!2024`, `MyPassword1234`).
 *
 * Pure data and pure functions, no I/O: the policy runs in a server action and in tests alike.
 */

/** Common passwords of 12 bytes or more, lower case. (Anything shorter never reaches this list: the length rule refuses it first.) */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password1234",
  "password12345",
  "password123456",
  "password1234567",
  "passw0rd1234",
  "p@ssw0rd1234",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789abc",
  "111111111111",
  "000000000000",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwertyuiopas",
  "qwertyuiopasdfghjkl",
  "asdfghjkl123",
  "asdfghjklqwe",
  "zxcvbnm12345",
  "1qaz2wsx3edc",
  "1q2w3e4r5t6y",
  "q1w2e3r4t5y6",
  "iloveyou1234",
  "iloveyou12345",
  "letmein123456",
  "welcome12345",
  "welcome123456",
  "administrator",
  "administrator1",
  "administrator123",
  "changeme1234",
  "changemechangeme",
  "changeme12345",
  "trustno1trustno1",
  "abc123abc123",
  "abcdefghijkl",
  "abcdefghij12",
  "superschema123",
  "superschema1234",
  "super-schema-123",
  "admin12345678",
  "adminadminadmin",
  "default12345",
  "letmeinletmein",
  "monkey123456",
  "dragon123456",
  "football1234",
  "baseball1234",
  "sunshine1234",
  "princess1234",
  "master123456",
  "secret123456",
]);

/**
 * Letters-only words that make a password trivial however they are dressed (case, digits, symbols, a "my" in front, said twice). All of them
 * are 5 letters or more, so a random password does not contain one by accident.
 */
export const DENIED_BASE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwort",
  "letmein",
  "welcome",
  "qwerty",
  "qwertyuiop",
  "asdfgh",
  "asdfghjkl",
  "zxcvbnm",
  "admin",
  "administrator",
  "iloveyou",
  "changeme",
  "secret",
  "superschema",
  "trustno",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "sunshine",
  "princess",
  "master",
  "default",
  "login",
]);

/** Little words that may sit around a denied word without making it any better: `mypassword`, `thesecret`, `iloveyou`. */
const FILLERS: readonly string[] = ["my", "the", "our", "your", "super", "new", "old", "ilove", "is", "no", "and", "to", "a", "i"];

/** Look-alikes people type for a letter. `1` stays out: it is as much an `i` as an `l`, and a trailing `1` is just a digit. */
const LEET: Readonly<Record<string, string>> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

const BASE_WORDS_LONGEST_FIRST: readonly string[] = [...DENIED_BASE_WORDS].sort((a, b) => b.length - a.length);

/** Lower case, look-alikes folded to letters, everything that is not a letter dropped. */
function foldLetters(text: string): string {
  let out = "";
  for (const char of text.toLowerCase()) {
    const folded = LEET[char] ?? char;
    if (folded >= "a" && folded <= "z") out += folded;
  }
  return out;
}

/** The text without its leading and trailing characters that are not letters (`!!Password2024!` -> `Password`), so a year or a bang is not a disguise. */
function trimNonLetters(text: string): string {
  return text.replace(/^[^a-z]+|[^a-z]+$/gi, "");
}

/** Is `letters` made of nothing but denied words (and fillers between them), with at least one denied word in it? */
function isOnlyDeniedWords(letters: string): boolean {
  if (letters === "") return false;
  let rest = letters;
  let removedWord = false;
  for (const word of BASE_WORDS_LONGEST_FIRST) {
    if (rest.includes(word)) {
      rest = rest.split(word).join("");
      removedWord = true;
    }
  }
  if (!removedWord) return false;
  for (const filler of FILLERS) rest = rest.split(filler).join("");
  return rest === "";
}

/**
 * Is this password a denied word in disguise, or a listed common password? The text is looked at two ways, and either one decides: with its
 * leading and trailing digits and symbols cut off first and only the look-alikes INSIDE it folded (`Passw0rd1234567` -> `password`), and
 * with every look-alike folded (`@dmin` -> `admin`). Pure.
 */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  return isOnlyDeniedWords(foldLetters(trimNonLetters(lower))) || isOnlyDeniedWords(foldLetters(lower));
}
