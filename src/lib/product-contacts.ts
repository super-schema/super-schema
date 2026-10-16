/**
 * A product's contacts: an Engineering Lead and a Manager (one mailbox each) and the team's email addresses. Each is stored as
 * canonical mailbox text (see `@/lib/mailbox`): `jane@acme.com` or `Jane Doe <jane@acme.com>`. Pure and client-safe — the
 * create form checks a draft with it live, and the product service runs `normalizeProductContacts` again before saving, so a
 * hand-written action call is held to the same rules.
 */

import { err, ok } from "@/types/result";
import type { Result } from "@/types/result";
import { dedupeMailboxes, formatMailbox, parseMailbox, parseOptionalMailbox, splitMailboxEntries } from "@/lib/mailbox";
import type { Mailbox } from "@/lib/mailbox";

export const MAX_TEAM_EMAILS = 50;

export interface ProductContacts {
  engineeringLead: string | null;
  manager: string | null;
  teamEmails: string[];
}

export type ProductContactField = keyof ProductContacts;
export type ProductContactErrors = Partial<Record<ProductContactField, string>>;

/** What a caller may send: every field optional (absent = leave alone on update, empty on create). */
export interface ProductContactsInput {
  engineeringLead?: string | null;
  manager?: string | null;
  teamEmails?: readonly string[] | null;
}

function normalizeSingle(raw: string | null | undefined): Result<string | null> {
  const parsed = parseOptionalMailbox(raw);
  if (!parsed.success) return parsed;
  return ok(parsed.data ? formatMailbox(parsed.data) : null);
}

function normalizeTeamEmails(raw: readonly string[] | null): Result<string[]> {
  const mailboxes: Mailbox[] = [];
  for (const entry of raw ?? []) {
    if (typeof entry === "string" && entry.trim() === "") continue;
    const parsed = parseMailbox(entry);
    if (!parsed.success) return parsed;
    mailboxes.push(parsed.data);
  }
  const unique = dedupeMailboxes(mailboxes);
  if (unique.length > MAX_TEAM_EMAILS) {
    return err({ code: "VALIDATION_ERROR", message: `Add at most ${MAX_TEAM_EMAILS} team email addresses.` });
  }
  return ok(unique.map(formatMailbox));
}

/**
 * Validates and canonicalises the contacts in `input`. Only the fields that are present (not `undefined`) are in the result;
 * `null` / blank clears a mailbox, `null` / `[]` clears the team list. All problems are reported together: the failure's
 * `details.fieldErrors` maps each bad field to its message, and its `message` is the first of them.
 */
export function normalizeProductContacts(input: ProductContactsInput): Result<Partial<ProductContacts>> {
  const data: Partial<ProductContacts> = {};
  const fieldErrors: ProductContactErrors = {};

  for (const field of ["engineeringLead", "manager"] as const) {
    if (input[field] === undefined) continue;
    const normalized = normalizeSingle(input[field]);
    if (normalized.success) data[field] = normalized.data;
    else fieldErrors[field] = normalized.error.message;
  }

  if (input.teamEmails !== undefined) {
    const normalized = normalizeTeamEmails(input.teamEmails);
    if (normalized.success) data.teamEmails = normalized.data;
    else fieldErrors.teamEmails = normalized.error.message;
  }

  const messages = Object.values(fieldErrors);
  if (messages.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: messages[0], details: { fieldErrors } });
  }
  return ok(data);
}

/** The create form's contact state: the two single inputs as typed, the team chips (canonical text) and the chip input's pending text. */
export interface ProductContactsDraft {
  engineeringLead: string;
  manager: string;
  teamEmails: string[];
  teamDraft: string;
}

export const EMPTY_PRODUCT_CONTACTS_DRAFT: ProductContactsDraft = {
  engineeringLead: "",
  manager: "",
  teamEmails: [],
  teamDraft: "",
};

/**
 * What the form submits for a draft: pending text in the chip input counts as typed-but-not-yet-added addresses (so a submit
 * never silently drops it). Fails with a message per bad field.
 */
export function resolveProductContactsDraft(draft: ProductContactsDraft): Result<ProductContacts, ProductContactErrors> {
  const normalized = normalizeProductContacts({
    engineeringLead: draft.engineeringLead,
    manager: draft.manager,
    teamEmails: [...draft.teamEmails, ...splitMailboxEntries(draft.teamDraft)],
  });
  if (!normalized.success) {
    const details = normalized.error.details as { fieldErrors?: ProductContactErrors } | undefined;
    return { success: false, error: details?.fieldErrors ?? {} };
  }
  return ok({
    engineeringLead: normalized.data.engineeringLead ?? null,
    manager: normalized.data.manager ?? null,
    teamEmails: normalized.data.teamEmails ?? [],
  });
}
