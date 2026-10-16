import { describe, expect, it } from "vitest";
import {
  formatMailbox,
  hasOpenQuote,
  mailboxEmailKey,
  mailtoHref,
  parseMailbox,
  parseMailboxList,
  parseOptionalMailbox,
  splitMailboxEntries,
  type Mailbox,
} from "@/lib/mailbox";

function mailbox(input: string): Mailbox {
  const result = parseMailbox(input);
  if (!result.success) throw new Error(`expected "${input}" to parse: ${result.error.message}`);
  return result.data;
}

function failure(input: string): string {
  const result = parseMailbox(input);
  if (result.success) throw new Error(`expected "${input}" to be rejected`);
  expect(result.error.code).toBe("VALIDATION_ERROR");
  return result.error.message;
}

describe("parseMailbox", () => {
  it("parses a bare email address", () => {
    expect(mailbox("jane@acme.com")).toEqual({ name: null, email: "jane@acme.com" });
  });

  it("parses `Name <email>`", () => {
    expect(mailbox("Jane Doe <jane@acme.com>")).toEqual({ name: "Jane Doe", email: "jane@acme.com" });
  });

  it("parses a quoted name that contains a comma", () => {
    expect(mailbox('"Doe, Jane" <jane@acme.com>')).toEqual({ name: "Doe, Jane", email: "jane@acme.com" });
  });

  it("unescapes backslash-escaped quotes and backslashes inside a quoted name", () => {
    expect(mailbox('"Jane \\"JD\\" Doe" <jane@acme.com>')).toEqual({ name: 'Jane "JD" Doe', email: "jane@acme.com" });
    expect(mailbox('"back\\\\slash" <jane@acme.com>')).toEqual({ name: "back\\slash", email: "jane@acme.com" });
  });

  it("treats a quoted name without special characters like an unquoted one", () => {
    expect(mailbox('"Jane Doe" <jane@acme.com>')).toEqual({ name: "Jane Doe", email: "jane@acme.com" });
  });

  it("accepts an address in angle brackets with no name, and an empty quoted name, as nameless", () => {
    expect(mailbox("<jane@acme.com>")).toEqual({ name: null, email: "jane@acme.com" });
    expect(mailbox('"" <jane@acme.com>')).toEqual({ name: null, email: "jane@acme.com" });
  });

  it("trims the input and collapses whitespace inside the name", () => {
    expect(mailbox("   Jane    Doe   <  jane@acme.com  >  ")).toEqual({ name: "Jane Doe", email: "jane@acme.com" });
    expect(mailbox("  jane@acme.com\t")).toEqual({ name: null, email: "jane@acme.com" });
  });

  it("accepts apostrophes, hyphens, dots and non-ASCII letters in an unquoted name", () => {
    expect(mailbox("Dr. Jean-Luc O'Brien <jl@acme.com>").name).toBe("Dr. Jean-Luc O'Brien");
    expect(mailbox("José Núñez <jose@acme.com>").name).toBe("José Núñez");
  });

  it("keeps the email exactly as typed (case included)", () => {
    expect(mailbox("Jane <Jane.Doe+Billing@Acme.COM>").email).toBe("Jane.Doe+Billing@Acme.COM");
  });

  it("accepts plus-tags, subdomains and multi-dot local parts", () => {
    expect(mailbox("a.b+c@mail.eu.acme.co.uk").email).toBe("a.b+c@mail.eu.acme.co.uk");
  });

  it.each([
    ["not an email", "plainly not an email"],
    ["missing @", "jane.acme.com"],
    ["missing domain", "jane@"],
    ["missing local part", "@acme.com"],
    ["domain without a dot", "jane@localhost"],
    ["numeric top-level domain", "jane@acme.123"],
    ["consecutive dots", "jane..doe@acme.com"],
    ["leading dot", ".jane@acme.com"],
    ["trailing dot in the local part", "jane.@acme.com"],
    ["dash-leading domain label", "jane@-acme.com"],
    ["two @", "jane@x@acme.com"],
    ["space inside the address", "ja ne@acme.com"],
    ["a name without angle brackets", "Jane Doe jane@acme.com"],
    ["an empty angle address", "Jane Doe <>"],
    ["an invalid angle address", "Jane Doe <jane>"],
    ["a missing closing bracket", "Jane Doe <jane@acme.com"],
    ["text after the closing bracket", "Jane Doe <jane@acme.com> extra"],
    ["an unterminated quote", '"Doe, Jane <jane@acme.com>'],
    ["text after a closed quote before the bracket", '"Doe" Jane <jane@acme.com>'],
  ])("rejects %s", (_label, input) => {
    expect(failure(input)).not.toBe("");
  });

  it("rejects an empty or whitespace-only input", () => {
    expect(failure("")).toMatch(/enter an email address/i);
    expect(failure("   ")).toMatch(/enter an email address/i);
  });

  it("asks for quotes when an unquoted name contains a comma or another special character", () => {
    expect(failure("Doe, Jane <jane@acme.com>")).toMatch(/quotes/i);
    expect(failure("Jane (JD) <jane@acme.com>")).toMatch(/quotes/i);
    expect(failure("jane@home <jane@acme.com>")).toMatch(/quotes/i);
  });

  it("names the offending text in the message", () => {
    expect(failure("not-an-email")).toContain("not-an-email");
  });

  it("truncates a very long offending text in the message", () => {
    expect(failure("x".repeat(500)).length).toBeLessThan(300);
  });

  it("rejects control characters", () => {
    expect(failure("Jane\u0007 <jane@acme.com>")).not.toBe("");
    expect(failure("jane@acme.com\u0000")).not.toBe("");
  });

  it("rejects an address over 254 characters and a local part over 64", () => {
    expect(failure(`${"a".repeat(65)}@acme.com`)).not.toBe("");
    expect(failure(`a@${"b".repeat(250)}.com`)).not.toBe("");
  });

  it("rejects a name over 100 characters", () => {
    expect(failure(`${"N".repeat(101)} <jane@acme.com>`)).toMatch(/100/);
  });

  it("never throws on non-string input", () => {
    expect(() => parseMailbox(undefined as unknown as string)).not.toThrow();
    expect(parseMailbox(null as unknown as string).success).toBe(false);
    expect(parseMailbox(42 as unknown as string).success).toBe(false);
  });
});

describe("parseOptionalMailbox", () => {
  it("returns null for null, undefined and blank input", () => {
    for (const blank of [null, undefined, "", "   ", "\n"]) {
      expect(parseOptionalMailbox(blank)).toEqual({ success: true, data: null });
    }
  });

  it("parses a non-blank input", () => {
    expect(parseOptionalMailbox("Jane <jane@acme.com>")).toEqual({
      success: true,
      data: { name: "Jane", email: "jane@acme.com" },
    });
  });

  it("rejects a malformed non-blank input", () => {
    const result = parseOptionalMailbox("nope");
    expect(result.success).toBe(false);
  });
});

describe("formatMailbox", () => {
  it("formats a nameless mailbox as the bare email", () => {
    expect(formatMailbox({ name: null, email: "jane@acme.com" })).toBe("jane@acme.com");
    expect(formatMailbox({ name: "  ", email: "jane@acme.com" })).toBe("jane@acme.com");
  });

  it("formats a named mailbox as `Name <email>`", () => {
    expect(formatMailbox({ name: "Jane Doe", email: "jane@acme.com" })).toBe("Jane Doe <jane@acme.com>");
  });

  it("quotes a name that contains a comma or another special character", () => {
    expect(formatMailbox({ name: "Doe, Jane", email: "jane@acme.com" })).toBe('"Doe, Jane" <jane@acme.com>');
    expect(formatMailbox({ name: "Jane (JD)", email: "jane@acme.com" })).toBe('"Jane (JD)" <jane@acme.com>');
  });

  it("escapes quotes and backslashes inside a quoted name", () => {
    expect(formatMailbox({ name: 'Jane "JD", Doe', email: "jane@acme.com" })).toBe('"Jane \\"JD\\", Doe" <jane@acme.com>');
    expect(formatMailbox({ name: "back\\slash, x", email: "jane@acme.com" })).toBe('"back\\\\slash, x" <jane@acme.com>');
  });

  it("is a fixed point of parse then format for the canonical forms (round trip)", () => {
    const canonical = [
      "jane@acme.com",
      "Jane Doe <jane@acme.com>",
      '"Doe, Jane" <j@x.com>',
      '"Jane \\"JD\\" Doe" <jane@acme.com>',
      '"semi; colon" <jane@acme.com>',
      'Dr. Jean-Luc O\'Brien <jl@acme.com>',
      "José Núñez <jose@acme.com>",
    ];
    for (const text of canonical) {
      expect(formatMailbox(mailbox(text))).toBe(text);
    }
  });

  it("canonicalises non-canonical but valid input", () => {
    expect(formatMailbox(mailbox('"Jane Doe" <jane@acme.com>'))).toBe("Jane Doe <jane@acme.com>");
    expect(formatMailbox(mailbox("<jane@acme.com>"))).toBe("jane@acme.com");
    expect(formatMailbox(mailbox("  Jane   Doe  < jane@acme.com >"))).toBe("Jane Doe <jane@acme.com>");
  });

  it("round-trips a display name that has every special character", () => {
    const original: Mailbox = { name: 'A, B; C <D> (E) [F] : G @ H \\ "I"', email: "x@acme.com" };
    expect(mailbox(formatMailbox(original))).toEqual(original);
  });
});

describe("splitMailboxEntries", () => {
  it("splits on commas, semicolons and newlines (CRLF included)", () => {
    expect(splitMailboxEntries("a@x.com, b@x.com; c@x.com\nd@x.com\r\ne@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
      "e@x.com",
    ]);
  });

  it("does not split a comma or semicolon inside a quoted name", () => {
    expect(splitMailboxEntries('"Doe, Jane" <j@x.com>, "Roe; Rick" <r@x.com>')).toEqual([
      '"Doe, Jane" <j@x.com>',
      '"Roe; Rick" <r@x.com>',
    ]);
  });

  it("honours a backslash-escaped quote inside a quoted name", () => {
    expect(splitMailboxEntries('"Say \\"hi, there\\"" <j@x.com>, b@x.com')).toEqual(['"Say \\"hi, there\\"" <j@x.com>', "b@x.com"]);
  });

  it("drops empty entries and trims the rest", () => {
    expect(splitMailboxEntries("  a@x.com ,, ;\n\n  b@x.com  ,")).toEqual(["a@x.com", "b@x.com"]);
    expect(splitMailboxEntries("")).toEqual([]);
    expect(splitMailboxEntries(" , ; \n")).toEqual([]);
  });

  it("a newline always ends an entry, so an unterminated quote cannot swallow the following lines", () => {
    expect(splitMailboxEntries('"broken <a@x.com>\nb@x.com')).toEqual(['"broken <a@x.com>', "b@x.com"]);
  });

  it("keeps an unterminated quote with the rest of its line", () => {
    expect(splitMailboxEntries('"Doe, Jane <j@x.com>, b@x.com')).toEqual(['"Doe, Jane <j@x.com>, b@x.com']);
  });
});

describe("hasOpenQuote", () => {
  it("is true while a quote is open and false once it closes", () => {
    expect(hasOpenQuote('"Doe')).toBe(true);
    expect(hasOpenQuote('"Doe, Jane"')).toBe(false);
    expect(hasOpenQuote("Doe")).toBe(false);
    expect(hasOpenQuote("")).toBe(false);
  });

  it("ignores an escaped quote inside an open quote", () => {
    expect(hasOpenQuote('"Say \\"hi')).toBe(true);
    expect(hasOpenQuote('"Say \\"hi\\""')).toBe(false);
  });

  it("only looks at the text after the last newline", () => {
    expect(hasOpenQuote('"open\nplain')).toBe(false);
  });
});

describe("parseMailboxList", () => {
  it("parses comma, semicolon and newline separated values", () => {
    const result = parseMailboxList("a@x.com, Bee <b@x.com>; c@x.com\nCee <d@x.com>");
    expect(result).toEqual({
      success: true,
      data: [
        { name: null, email: "a@x.com" },
        { name: "Bee", email: "b@x.com" },
        { name: null, email: "c@x.com" },
        { name: "Cee", email: "d@x.com" },
      ],
    });
  });

  it("does not split on a comma inside a quoted name", () => {
    const result = parseMailboxList('"Doe, Jane" <j@x.com>, plain@x.com');
    expect(result).toEqual({
      success: true,
      data: [
        { name: "Doe, Jane", email: "j@x.com" },
        { name: null, email: "plain@x.com" },
      ],
    });
  });

  it("collapses duplicate emails case-insensitively and keeps the first occurrence", () => {
    const result = parseMailboxList("Jane <jane@acme.com>, JANE@ACME.COM, other@acme.com, jane@acme.com");
    expect(result).toEqual({
      success: true,
      data: [
        { name: "Jane", email: "jane@acme.com" },
        { name: null, email: "other@acme.com" },
      ],
    });
  });

  it("treats blank input as an empty list", () => {
    expect(parseMailboxList("")).toEqual({ success: true, data: [] });
    expect(parseMailboxList("  \n ; , ")).toEqual({ success: true, data: [] });
  });

  it("ignores empty entries from doubled or trailing separators", () => {
    const result = parseMailboxList("a@x.com,, b@x.com,");
    expect(result.success && result.data.map((m) => m.email)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("rejects the whole list with a message naming the first bad entry", () => {
    const result = parseMailboxList("a@x.com, nope, b@x.com, also-bad");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.message).toContain("nope");
      expect(result.error.message).not.toContain("also-bad");
    }
  });

  it("rejects an unquoted display name with a comma, because the comma splits it", () => {
    const result = parseMailboxList("Doe, Jane <j@x.com>");
    expect(result.success).toBe(false);
  });

  it("never throws on non-string input", () => {
    expect(parseMailboxList(undefined as unknown as string)).toEqual({ success: true, data: [] });
  });
});

describe("mailboxEmailKey", () => {
  it("is the lower-cased email", () => {
    expect(mailboxEmailKey({ name: "Jane", email: "Jane@Acme.COM" })).toBe("jane@acme.com");
  });
});

describe("mailtoHref", () => {
  it("builds a mailto link that keeps the @ readable", () => {
    expect(mailtoHref("jane@acme.com")).toBe("mailto:jane@acme.com");
  });

  it("percent-encodes a plus-tag, so no mail client can read the + as a space", () => {
    expect(mailtoHref("jane+billing@acme.com")).toBe("mailto:jane%2Bbilling@acme.com");
  });

  it("percent-encodes characters that would end the address or start a query", () => {
    expect(mailtoHref("a?b&c%d@acme.com")).toBe("mailto:a%3Fb%26c%25d@acme.com");
  });
});
