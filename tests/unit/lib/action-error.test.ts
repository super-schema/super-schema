import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERIC_ACTION_ERROR, noticeFor, settleAction } from "@/lib/action-error";

describe("noticeFor", () => {
  it("passes service messages and the suggested fix through", () => {
    expect(noticeFor({ error: "Name is already used", code: "CONFLICT", suggestedFix: "Pick another name" })).toEqual({
      message: "Name is already used", fix: "Pick another name",
    });
    expect(noticeFor({ error: "Plain failure" })).toEqual({ message: "Plain failure" });
  });

  it("never shows database / internal error text (generic message, no fix)", () => {
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      expect(noticeFor({ error: 'relation "channels" does not exist', code, suggestedFix: "run psql" })).toEqual({ message: GENERIC_ACTION_ERROR });
    }
  });
});

describe("settleAction", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => consoleError.mockRestore());

  it("returns the action's result untouched", async () => {
    const result = { success: true as const, data: { id: "c1" } };
    expect(await settleAction(async () => result)).toBe(result);
  });

  it("turns a rejected / thrown action into a generic INTERNAL_ERROR failure and logs the original", async () => {
    const thrown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    expect(await settleAction(() => Promise.reject(thrown))).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
    expect(consoleError).toHaveBeenCalledWith("[settleAction] action failed", thrown);
    expect(await settleAction(() => { throw thrown; })).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "INTERNAL_ERROR" });
  });
});
