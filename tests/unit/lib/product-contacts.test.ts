import { describe, expect, it } from "vitest";
import {
  EMPTY_PRODUCT_CONTACTS_DRAFT,
  MAX_TEAM_EMAILS,
  normalizeProductContacts,
  resolveProductContactsDraft,
} from "@/lib/product-contacts";

function fieldErrors(input: Parameters<typeof normalizeProductContacts>[0]) {
  const result = normalizeProductContacts(input);
  if (result.success) throw new Error("expected a validation failure");
  expect(result.error.code).toBe("VALIDATION_ERROR");
  return (result.error.details as { fieldErrors: Record<string, string> }).fieldErrors;
}

describe("normalizeProductContacts", () => {
  it("returns canonical strings for every field that is present", () => {
    const result = normalizeProductContacts({
      engineeringLead: '  "Doe, Jane"   <jane@acme.com> ',
      manager: "<mo@acme.com>",
      teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
    });
    expect(result).toEqual({
      success: true,
      data: {
        engineeringLead: '"Doe, Jane" <jane@acme.com>',
        manager: "mo@acme.com",
        teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
      },
    });
  });

  it("turns blank or null lead and manager into null", () => {
    const result = normalizeProductContacts({ engineeringLead: "   ", manager: null });
    expect(result).toEqual({ success: true, data: { engineeringLead: null, manager: null } });
  });

  it("leaves fields that were not provided out of the result (so an update does not touch them)", () => {
    const result = normalizeProductContacts({ manager: "mo@acme.com" });
    expect(result).toEqual({ success: true, data: { manager: "mo@acme.com" } });
    expect("engineeringLead" in (result.success ? result.data : {})).toBe(false);
    expect("teamEmails" in (result.success ? result.data : {})).toBe(false);
  });

  it("treats a null or empty teamEmails as an empty list", () => {
    expect(normalizeProductContacts({ teamEmails: null })).toEqual({ success: true, data: { teamEmails: [] } });
    expect(normalizeProductContacts({ teamEmails: [] })).toEqual({ success: true, data: { teamEmails: [] } });
  });

  it("collapses duplicate team emails case-insensitively, keeping the first", () => {
    const result = normalizeProductContacts({ teamEmails: ["Ops <ops@acme.com>", "OPS@acme.com", "dev@acme.com"] });
    expect(result).toEqual({ success: true, data: { teamEmails: ["Ops <ops@acme.com>", "dev@acme.com"] } });
  });

  it("skips blank team email entries", () => {
    const result = normalizeProductContacts({ teamEmails: ["", "  ", "dev@acme.com"] });
    expect(result).toEqual({ success: true, data: { teamEmails: ["dev@acme.com"] } });
  });

  it("round-trips a team email with a comma in the display name", () => {
    const first = normalizeProductContacts({ teamEmails: ['"Doe, Jane" <j@x.com>'] });
    expect(first).toEqual({ success: true, data: { teamEmails: ['"Doe, Jane" <j@x.com>'] } });
    const again = normalizeProductContacts({ teamEmails: first.success ? first.data.teamEmails : [] });
    expect(again).toEqual(first);
  });

  it("reports a field-level message for a bad lead, a bad manager and a bad team entry, all at once", () => {
    const errors = fieldErrors({
      engineeringLead: "jane",
      manager: "mo@",
      teamEmails: ["ok@acme.com", "broken"],
    });
    expect(Object.keys(errors).sort()).toEqual(["engineeringLead", "manager", "teamEmails"]);
    expect(errors.engineeringLead).toContain("jane");
    expect(errors.manager).toContain("mo@");
    expect(errors.teamEmails).toContain("broken");
  });

  it("only reports the fields that are wrong", () => {
    expect(Object.keys(fieldErrors({ engineeringLead: "ok@acme.com", manager: "nope" }))).toEqual(["manager"]);
  });

  it("uses the first field message as the overall error message", () => {
    const result = normalizeProductContacts({ engineeringLead: "jane" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe((result.error.details as { fieldErrors: Record<string, string> }).fieldErrors.engineeringLead);
    }
  });

  it("rejects a non-string team email entry without throwing", () => {
    expect(fieldErrors({ teamEmails: [42 as unknown as string] }).teamEmails).toBeTruthy();
  });

  it("rejects more than the team email limit", () => {
    const many = Array.from({ length: MAX_TEAM_EMAILS + 1 }, (_, i) => `team${i}@acme.com`);
    expect(fieldErrors({ teamEmails: many }).teamEmails).toContain(String(MAX_TEAM_EMAILS));
    const exactly = many.slice(0, MAX_TEAM_EMAILS);
    expect(normalizeProductContacts({ teamEmails: exactly }).success).toBe(true);
  });

  it("counts the limit after duplicates collapse", () => {
    const entries = Array.from({ length: MAX_TEAM_EMAILS + 10 }, () => "same@acme.com");
    expect(normalizeProductContacts({ teamEmails: entries })).toEqual({ success: true, data: { teamEmails: ["same@acme.com"] } });
  });
});

describe("resolveProductContactsDraft", () => {
  it("resolves the empty draft to no contacts", () => {
    expect(resolveProductContactsDraft(EMPTY_PRODUCT_CONTACTS_DRAFT)).toEqual({
      success: true,
      data: { engineeringLead: null, manager: null, teamEmails: [] },
    });
  });

  it("folds the pending text of the chip input into the team emails", () => {
    const result = resolveProductContactsDraft({
      ...EMPTY_PRODUCT_CONTACTS_DRAFT,
      engineeringLead: "Jane Doe <jane@acme.com>",
      teamEmails: ["a@acme.com"],
      teamDraft: '"Doe, Jane" <j@x.com>, b@acme.com; a@acme.com',
    });
    expect(result).toEqual({
      success: true,
      data: {
        engineeringLead: "Jane Doe <jane@acme.com>",
        manager: null,
        teamEmails: ["a@acme.com", '"Doe, Jane" <j@x.com>', "b@acme.com"],
      },
    });
  });

  it("returns field errors, keyed by field, for an invalid draft", () => {
    const result = resolveProductContactsDraft({
      engineeringLead: "jane",
      manager: "",
      teamEmails: [],
      teamDraft: "not-an-address",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Object.keys(result.error).sort()).toEqual(["engineeringLead", "teamEmails"]);
      expect(result.error.teamEmails).toContain("not-an-address");
    }
  });
});
