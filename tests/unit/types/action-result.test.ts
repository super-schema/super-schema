import { describe, expect, it } from "vitest";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";

describe("actionErrorText", () => {
  it("hides DB_ERROR and INTERNAL_ERROR messages and suggested fixes", () => {
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      expect(actionErrorText({ code, error: "Invalid `prisma.x.create()` invocation", suggestedFix: "Check DATABASE_URL" })).toBe(GENERIC_ACTION_ERROR);
    }
  });

  it("shows any other failure's message, with its suggested fix when there is one", () => {
    expect(actionErrorText({ code: "NAME_CONFLICT", error: "Name taken", suggestedFix: "Pick another." })).toBe("Name taken Pick another.");
    expect(actionErrorText({ code: "FORBIDDEN", error: "Not allowed" })).toBe("Not allowed");
    expect(actionErrorText({ error: "No code at all" })).toBe("No code at all");
  });
});
