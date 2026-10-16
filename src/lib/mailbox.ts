/**
 * Mailboxes: an email address, optionally with its person's display name — `jane@acme.com`, `Jane Doe <jane@acme.com>` or
 * `"Doe, Jane" <jane@acme.com>` (a name with a comma or another special character goes in quotes, as in RFC 5322). Pure and
 * client-safe: the product forms validate with it live and the product service validates again with it before saving.
 *
 * Canonical text (what the database stores) is `formatMailbox(parseMailbox(text))`: the name is trimmed and its whitespace
 * collapsed, quotes appear only where the name needs them, the email is kept exactly as typed.
 *
 * Nothing here throws: bad input is a `VALIDATION_ERROR` Result whose message is written for the person who typed it.
 */

import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";

export interface Mailbox {
  /** The person's display name, or null when only the address was given. */
  name: string | null;
  email: string;
}

export const MAX_EMAIL_LENGTH = 254;
export const MAX_EMAIL_LOCAL_LENGTH = 64;
export const MAX_MAILBOX_NAME_LENGTH = 100;

const EXAMPLE = "jane@acme.com or Jane Doe <jane@acme.com>";
const ECHO_LIMIT = 60;

/** Characters that force a display name into quotes (RFC 5322 specials; `.` stays allowed so `Dr. Who` needs none). */
const NAME_SPECIALS = /[()<>[\]:;@\\,"]/;
/** C0 / DEL control characters other than tab, line feed and carriage return (those count as whitespace). */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const LOCAL_PART = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

function invalid(message: string): Result<never> {
  return err({ code: "VALIDATION_ERROR", message });
}

/** The offending text, quoted and cut short, for use inside a message. */
function echo(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return `"${flat.length > ECHO_LIMIT ? `${flat.slice(0, ECHO_LIMIT)}…` : flat}"`;
}

function isEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  const at = value.indexOf("@");
  if (at < 1 || at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > MAX_EMAIL_LOCAL_LENGTH || !LOCAL_PART.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => label.length >= 1 && label.length <= 63 && DOMAIN_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  return tld.length >= 2 && !/^\p{N}+$/u.test(tld);
}

/**
 * Reads the quoted string that starts at `text[0]` (a `"`). Returns its unescaped content and the index just past the closing
 * quote, or null when the quote never closes.
 */
function readQuoted(text: string): { value: string; end: number } | null {
  let value = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i++;
    } else if (ch === '"') {
      return { value, end: i + 1 };
    } else {
      value += ch;
    }
  }
  return null;
}

function cleanName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name === "" ? null : name;
}

/**
 * Parses one mailbox: `email`, `Name <email>`, `"Quoted, Name" <email>` or `<email>`. A blank input is an error here — callers
 * with an optional field use {@link parseOptionalMailbox}.
 */
export function parseMailbox(input: string): Result<Mailbox> {
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") return invalid("Enter an email address.");
  if (CONTROL_CHARS.test(text)) return invalid(`${echo(text)} contains characters that are not allowed in an address.`);

  const badAddress = `${echo(text)} is not a valid email address. Use ${EXAMPLE}.`;
  const open = text.lastIndexOf("<");

  if (!text.endsWith(">")) {
    if (open !== -1 || text.includes(">")) return invalid(badAddress);
    return isEmailAddress(text) ? ok({ name: null, email: text }) : invalid(badAddress);
  }

  if (open === -1) return invalid(badAddress);
  const email = text.slice(open + 1, -1).trim();
  if (!isEmailAddress(email)) return invalid(`${echo(email || text)} is not a valid email address. Use ${EXAMPLE}.`);

  const namePart = text.slice(0, open).trim();
  let name: string | null;
  if (namePart.startsWith('"')) {
    const quoted = readQuoted(namePart);
    if (!quoted || quoted.end !== namePart.length) return invalid(badAddress);
    name = cleanName(quoted.value);
  } else {
    if (NAME_SPECIALS.test(namePart)) {
      return invalid('Put the name in quotes when it contains commas or other special characters, e.g. "Doe, Jane" <jane@acme.com>.');
    }
    name = cleanName(namePart);
  }

  if (name !== null && name.length > MAX_MAILBOX_NAME_LENGTH) {
    return invalid(`Names can be at most ${MAX_MAILBOX_NAME_LENGTH} characters.`);
  }
  return ok({ name, email });
}

/** Like {@link parseMailbox}, but a missing or blank input is a valid "no mailbox" (null). */
export function parseOptionalMailbox(input: string | null | undefined): Result<Mailbox | null> {
  if (input === null || input === undefined || (typeof input === "string" && input.trim() === "")) return ok(null);
  return parseMailbox(input);
}

/** The canonical text of a mailbox: the bare email, or `Name <email>` with the name quoted only when it needs it. */
export function formatMailbox(mailbox: Mailbox): string {
  const name = mailbox.name?.trim();
  if (!name) return mailbox.email;
  const shown = NAME_SPECIALS.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
  return `${shown} <${mailbox.email}>`;
}

/** A `mailto:` link for an email: URI-encoded (so `?`, `&`, `%` and `+` cannot change its meaning) with the `@` left readable. */
export function mailtoHref(email: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}`;
}

/** The identity of a mailbox for duplicate detection: its email, case-insensitively. */
export function mailboxEmailKey(mailbox: Mailbox): string {
  return mailbox.email.toLowerCase();
}

/**
 * Splits list text into one entry per mailbox. Commas, semicolons and line breaks separate entries, except inside a quoted
 * display name; a line break always ends an entry (so an unterminated quote cannot swallow the following lines). Entries are
 * trimmed and empty ones dropped.
 */
export function splitMailboxEntries(input: string): string[] {
  const text = typeof input === "string" ? input : "";
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  const flush = () => {
    const entry = current.trim();
    if (entry !== "") entries.push(entry);
    current = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      flush();
      inQuotes = false;
    } else if (inQuotes) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") {
        current += text[++i];
      } else if (ch === '"') {
        inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
      current += ch;
    } else if (ch === "," || ch === ";") {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return entries;
}

/** True while the last line of `text` ends inside a quoted display name (so a comma typed there belongs to the name). */
export function hasOpenQuote(text: string): boolean {
  const line = text.slice(text.lastIndexOf("\n") + 1).replace(/\r/g, "");
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes && ch === "\\") i++;
    else if (ch === '"') inQuotes = !inQuotes;
  }
  return inQuotes;
}

/** Collapses mailboxes that share an email (case-insensitively), keeping the first occurrence of each. */
export function dedupeMailboxes(mailboxes: readonly Mailbox[]): Mailbox[] {
  const seen = new Set<string>();
  const unique: Mailbox[] = [];
  for (const mailbox of mailboxes) {
    const key = mailboxEmailKey(mailbox);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(mailbox);
  }
  return unique;
}

/**
 * Parses list text (see {@link splitMailboxEntries} for the separators). Blank input is an empty list; duplicate emails collapse
 * case-insensitively. The first malformed entry fails the whole list, and its message names that entry.
 */
export function parseMailboxList(input: string): Result<Mailbox[]> {
  const parsed: Mailbox[] = [];
  for (const entry of splitMailboxEntries(input)) {
    const result = parseMailbox(entry);
    if (!result.success) return result;
    parsed.push(result.data);
  }
  return ok(dedupeMailboxes(parsed));
}
