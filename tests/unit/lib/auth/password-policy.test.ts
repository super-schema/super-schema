/**
 * The password rule (access-control design, decision 8): 12 to 72 BYTES (bcrypt reads at most 72 bytes of the UTF-8 form and ignores the rest, so
 * the limit counts bytes, not characters), and a deny-list of trivial values: common passwords, "password" in its usual disguises, one character
 * or one short unit repeated, a plain run (123456789012, abcdefghijkl), the user's e-mail and its local part. E-mails are trimmed and lower-cased.
 */
import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  normalizeEmail,
  validatePassword,
} from "@/lib/auth/password-policy";
import { COMMON_PASSWORDS, DENIED_BASE_WORDS } from "@/lib/auth/common-passwords";

const refused = (password: unknown, email?: string) => {
  const result = validatePassword(password as string, email === undefined ? undefined : { email });
  expect(result.ok, `${JSON.stringify(password)} should be refused`).toBe(false);
  return result.ok ? "" : result.message;
};
const accepted = (password: string, email?: string) => {
  const result = validatePassword(password, email === undefined ? undefined : { email });
  expect(result.ok, `${JSON.stringify(password)} should be accepted: ${result.ok ? "" : result.message}`).toBe(true);
};

describe("normalizeEmail", () => {
  it.each([
    ["  Alice@Example.COM ", "alice@example.com"],
    ["bob@example.com", "bob@example.com"],
    ["\tCarol@Example.com\n", "carol@example.com"],
    ["", ""],
  ])("%j becomes %j", (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it("answers the empty string for anything that is not a string (it comes from a form)", () => {
    expect(normalizeEmail(undefined as unknown as string)).toBe("");
    expect(normalizeEmail(null as unknown as string)).toBe("");
    expect(normalizeEmail(42 as unknown as string)).toBe("");
    expect(normalizeEmail({} as unknown as string)).toBe("");
  });
});

describe("validatePassword: length is counted in bytes", () => {
  it("is 12 to 72 bytes", () => {
    expect([PASSWORD_MIN_BYTES, PASSWORD_MAX_BYTES]).toEqual([12, 72]);
  });

  it("refuses 11 bytes and accepts 12", () => {
    refused("Tr1cky-pw!x");
    accepted("Tr1cky-pw!xy");
  });

  it("accepts exactly 72 bytes and refuses 73", () => {
    const base = "Qz7!mK2#vR9&wL4@";
    accepted((base.repeat(5)).slice(0, 72));
    refused((base.repeat(5)).slice(0, 73));
  });

  it("counts bytes, not characters: 25 two-byte characters are 50 bytes (fine), 37 of them are 74 (too long) although 37 < 72", () => {
    accepted("é".repeat(5) + "Zq8!mK2#vR9&"); // 10 + 12 bytes
    const long = "ü".repeat(18) + "Zq8!mK2#vR9&wL4@x"; // 36 + 17 bytes: fine
    accepted(long);
    const tooLong = "ü".repeat(37); // 37 characters, 74 bytes
    expect(tooLong.length).toBe(37);
    expect(Buffer.byteLength(tooLong, "utf8")).toBe(74);
    expect(refused(tooLong)).toMatch(/72 bytes/);
  });

  it("counts a four-byte character (an emoji) as four", () => {
    // 3 emoji = 12 bytes: long enough, and they are not a run.
    accepted("\u{1F510}\u{1F9E0}\u{1F680}");
    // 19 emoji = 76 bytes.
    refused("\u{1F510}".repeat(19));
  });

  it("says why in terms a person can act on", () => {
    expect(refused("short1!")).toMatch(/at least 12 bytes/);
    expect(refused("x".repeat(80))).toMatch(/at most 72 bytes/);
  });

  it("refuses anything that is not a string, without throwing", () => {
    for (const value of [undefined, null, 123456789012, {}, ["a".repeat(20)]]) refused(value);
  });
});

describe("validatePassword: the deny-list", () => {
  it.each([
    "password1234",
    "Password1234",
    "123456789012",
    "qwertyuiop12",
    "iloveyou1234",
    "administrator",
    "letmein123456",
    "welcome12345",
    "changemechangeme",
  ])("refuses the common password %s", (password) => {
    expect(refused(password)).toMatch(/too easy to guess/);
  });

  it.each([
    ["Passw0rd!2024", "'password' with digits for letters and a year"],
    ["P@ssw0rd!!!!!", "'password' in leet speak"],
    ["P@$$w0rd12345", "'password' with symbols for letters"],
    ["MyPassword1234", "'password' behind a 'my'"],
    ["password-password", "'password' twice"],
    ["PASSWORD123456", "upper case"],
    ["p a s s w o r d 1", "spaced out"],
    ["superschema123", "this application's own name"],
  ])("refuses %s (%s)", (password) => {
    refused(password);
  });

  it.each([
    ["aaaaaaaaaaaa", "one character"],
    ["111111111111111", "one digit"],
    ["abababababab", "a two-character unit"],
    ["123123123123", "a three-character unit"],
    ["abcdabcdabcd", "a four-character unit"],
    ["!!!!!!!!!!!!", "one symbol"],
  ])("refuses %s (%s repeated)", (password) => {
    expect(refused(password)).toMatch(/repeat/i);
  });

  it.each(["abcdefghijkl", "zyxwvutsrqpo", "123456789012", "987654321098"])("refuses the plain run %s", (password) => {
    expect(refused(password)).toMatch(/too easy to guess/);
  });

  it("refuses the e-mail address, and any password that contains its local part", () => {
    expect(refused("alice@example.com", "alice@example.com")).toMatch(/e-mail/i);
    expect(refused("ALICE@EXAMPLE.COM", "alice@example.com")).toMatch(/e-mail/i);
    expect(refused("john.smith-2024-x!", "john.smith@example.com")).toMatch(/e-mail/i);
    expect(refused("JOHN.SMITH!!Zq81", "John.Smith@example.com")).toMatch(/e-mail/i);
  });

  it("ignores a local part that is too short to mean anything (a 2-letter name would refuse half the alphabet)", () => {
    accepted("Zq8!mK2#al9&wL4@", "al@example.com");
  });

  it("accepts a long passphrase and a random-looking password", () => {
    accepted("correct horse battery staple");
    accepted("Zq8!mK2#vR9&wL4@");
    accepted("tangerine-lantern-orbit-42");
  });

  it("does not refuse a good password just because it contains a short common word", () => {
    accepted("welcome-to-the-Zq8!mK2");
    accepted("my-admin-key: 4f9B!x7Qe");
  });

  it("keeps a real list: a few dozen common 12+ character passwords, all lower case and all refused themselves", () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(40);
    expect(DENIED_BASE_WORDS.size).toBeGreaterThanOrEqual(15);
    for (const entry of COMMON_PASSWORDS) {
      expect(entry).toBe(entry.toLowerCase());
      expect(Buffer.byteLength(entry, "utf8"), entry).toBeGreaterThanOrEqual(PASSWORD_MIN_BYTES);
      refused(entry);
    }
  });
});
