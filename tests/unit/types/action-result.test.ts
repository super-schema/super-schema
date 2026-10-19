import { describe, expect, it } from "vitest";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

describe("actionErrorText", () => {
  it("hides DB_ERROR and INTERNAL_ERROR messages and suggested fixes", () => {
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      expect(actionErrorText({ code, error: "Invalid `prisma.x.create()` invocation", suggestedFix: "Check DATABASE_URL" })).toBe(GENERIC_ACTION_ERROR);
    }
  });

  it("shows any other failure's message, with its suggested fix when there is one", () => {
    expect(actionErrorText({ code: "NAME_CONFLICT", error: "Name taken", suggestedFix: "Pick another." })).toBe("Name taken. Pick another.");
    expect(actionErrorText({ code: "FORBIDDEN", error: "Not allowed" })).toBe("Not allowed");
    expect(actionErrorText({ error: "No code at all" })).toBe("No code at all");
  });

  describe("the join of a message and its suggested fix", () => {
    const FIX = "Use 1–128 letters, digits, '.', '_' or '-'.";

    it("puts a full stop between them when the message has none (no run-on sentence)", () => {
      expect(actionErrorText({ error: 'Event name "x y" is invalid', suggestedFix: FIX })).toBe(`Event name "x y" is invalid. ${FIX}`);
    });

    it("joins with a single space when the message already ends a sentence", () => {
      expect(actionErrorText({ error: "Name taken.", suggestedFix: "Pick another." })).toBe("Name taken. Pick another.");
      expect(actionErrorText({ error: "Is that name taken?", suggestedFix: "Pick another." })).toBe("Is that name taken? Pick another.");
      expect(actionErrorText({ error: "Name taken!", suggestedFix: "Pick another." })).toBe("Name taken! Pick another.");
      expect(actionErrorText({ error: "These names are taken:", suggestedFix: "a, b." })).toBe("These names are taken: a, b.");
    });

    it("ignores trailing spaces of the message, and never leaves two full stops or a space before one", () => {
      expect(actionErrorText({ error: "Name taken   ", suggestedFix: "Pick another." })).toBe("Name taken. Pick another.");
      expect(actionErrorText({ error: "Name taken.  ", suggestedFix: "Pick another." })).toBe("Name taken. Pick another.");
      expect(actionErrorText({ error: "Name taken\n", suggestedFix: "Pick another." })).toBe("Name taken. Pick another.");
    });

    it("is the message alone, untouched, when there is no fix (or an empty one)", () => {
      expect(actionErrorText({ error: "Name taken" })).toBe("Name taken");
      expect(actionErrorText({ error: "Name taken  ", suggestedFix: "" })).toBe("Name taken  ");
      expect(actionErrorText({ error: "Name taken", suggestedFix: undefined })).toBe("Name taken");
    });

    it("is the fix alone for an empty message", () => {
      expect(actionErrorText({ error: "", suggestedFix: "Pick another." })).toBe("Pick another.");
      expect(actionErrorText({ error: "  ", suggestedFix: "Pick another." })).toBe("Pick another.");
    });

    it("keeps the opaque codes opaque, whatever the message and the fix look like", () => {
      for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
        expect(actionErrorText({ code, error: "boom", suggestedFix: "Retry." })).toBe(GENERIC_ACTION_ERROR);
        expect(actionErrorText({ code, error: "boom." })).toBe(GENERIC_ACTION_ERROR);
      }
      expect(actionErrorText({ code: "NOT_AN_OPAQUE_CODE", error: "boom", suggestedFix: "Retry." })).toBe("boom. Retry.");
    });
  });
});
