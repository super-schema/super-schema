import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getEffectiveRole: vi.fn(),
  resolveCurrentUserId: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: h.getEffectiveRole }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));

import { AuditUserMissingError } from "@/lib/audit";
import { GENERIC_ACTION_ERROR, getActionContext, NOT_AUTHENTICATED, runMutation, sanitizeActionError, toActionResult } from "@/lib/action-context";

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "session-id", email: "a@example.test" } });
  h.resolveCurrentUserId.mockResolvedValue("db-user");
  h.getEffectiveRole.mockResolvedValue({ success: true, data: "AUTHOR" });
});

/** What the server-side log line calls each opaque failure. */
const LOG_KIND: Record<string, string> = { DB_ERROR: "database error", INTERNAL_ERROR: "internal error" };

/** A spy on console.error for the tests that exercise a sanitized failure; restored after each test. */
function spyOnConsoleError() {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());
  return () => spy;
}

describe("toActionResult", () => {
  const consoleError = spyOnConsoleError();

  it("maps success data through", () => {
    expect(toActionResult({ success: true, data: { id: "1" } })).toEqual({ success: true, data: { id: "1" } });
  });

  it("carries code, details and suggestedFix on failure, omitting the ones that are absent", () => {
    expect(
      toActionResult({ success: false, error: { code: "VALIDATION_ERROR", message: "bad", details: { problems: ["x"] }, suggestedFix: "Fix x" } })
    ).toEqual({ success: false, error: "bad", code: "VALIDATION_ERROR", details: { problems: ["x"] }, suggestedFix: "Fix x" });
    const bare = toActionResult({ success: false, error: { code: "NOT_FOUND", message: "gone" } });
    expect(bare).toEqual({ success: false, error: "gone", code: "NOT_FOUND" });
    expect("details" in bare).toBe(false);
    expect("suggestedFix" in bare).toBe(false);
    expect(consoleError()).not.toHaveBeenCalled();
  });

  it.each(["DB_ERROR", "INTERNAL_ERROR"])(
    "turns a %s into the generic message with NO details / suggestedFix, and logs the original server-side",
    (code) => {
      const raw = 'Invalid `prisma.message.create()` invocation: relation "messages" does not exist (postgres://admin:s3cret@10.0.0.5:5432/db)';
      const details = { sql: "select * from messages", host: "10.0.0.5" };
      const r = toActionResult({ success: false, error: { code, message: raw, details, suggestedFix: "Check DATABASE_URL" } }, "createMessageAction");
      expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
      expect("details" in r).toBe(false);
      expect("suggestedFix" in r).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/prisma|messages|s3cret|10\.0\.0\.5|DATABASE_URL|select/);
      expect(consoleError()).toHaveBeenCalledTimes(1);
      expect(consoleError()).toHaveBeenCalledWith(`[createMessageAction] ${LOG_KIND[code]}`, raw);
    }
  );

  it("logs a sanitized failure under a default label when the caller names none", () => {
    toActionResult({ success: false, error: { code: "DB_ERROR", message: "pool exhausted" } });
    expect(consoleError()).toHaveBeenCalledWith("[action] database error", "pool exhausted");
  });

  it("is idempotent: a failure that is already the generic one (sanitized at the source or by sanitizeActionError) is not logged again", () => {
    for (const code of ["DB_ERROR", "INTERNAL_ERROR"]) {
      expect(toActionResult({ success: false, error: { code, message: GENERIC_ACTION_ERROR } })).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
    }
    expect(consoleError()).not.toHaveBeenCalled();
    // ... unless it still carries details / a suggested fix, which are stripped (and logged).
    expect(toActionResult({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR, details: { sql: "x" } } })).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    expect(consoleError()).toHaveBeenCalledTimes(1);
  });

  it("passes every other failure code through unchanged (message, details, suggestedFix) without logging", () => {
    for (const code of ["PUBLISH_BLOCKED", "BUMP_TOO_LOW", "INVALID_PLAN_INPUT", "CONFLICT", "NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR", "NAME_CONFLICT", "IN_USE", "VALIDATOR_FAILED", "SOMETHING_NEW"]) {
      const details = { blockers: [{ kind: "X" }] };
      expect(toActionResult({ success: false, error: { code, message: `${code} text`, details, suggestedFix: "Do this" } })).toEqual({
        success: false, error: `${code} text`, code, details, suggestedFix: "Do this",
      });
    }
    expect(consoleError()).not.toHaveBeenCalled();
  });
});

describe("getActionContext", () => {
  it("resolves the user through resolveCurrentUserId (id, then email fallback) and uses the resolved id for the role", async () => {
    const ctx = await getActionContext();
    expect(h.resolveCurrentUserId).toHaveBeenCalledWith({ id: "session-id", email: "a@example.test" });
    expect(h.getEffectiveRole).toHaveBeenCalledWith("db-user", null, expect.objectContaining({ userId: "db-user" }));
    expect(ctx).toMatchObject({ userId: "db-user", userRole: "AUTHOR" });
  });

  it("fails closed to VIEWER when the role lookup fails or is empty", async () => {
    h.getEffectiveRole.mockResolvedValueOnce({ success: false, error: { code: "DB_ERROR", message: "x" } });
    expect(await getActionContext()).toMatchObject({ userRole: "VIEWER" });
    h.getEffectiveRole.mockResolvedValueOnce({ success: true, data: null });
    expect(await getActionContext()).toMatchObject({ userRole: "VIEWER" });
  });

  it("returns null without a session, without a session user id, or for a stale session", async () => {
    h.auth.mockResolvedValueOnce(null);
    expect(await getActionContext()).toBeNull();
    h.auth.mockResolvedValueOnce({ user: { email: "a@example.test" } });
    expect(await getActionContext()).toBeNull();
    expect(h.resolveCurrentUserId).not.toHaveBeenCalled();
    h.resolveCurrentUserId.mockRejectedValueOnce(new AuditUserMissingError("session-id"));
    expect(await getActionContext()).toBeNull();
  });

  it("does not swallow unexpected errors from the user lookup", async () => {
    h.resolveCurrentUserId.mockRejectedValueOnce(new Error("db down"));
    await expect(getActionContext()).rejects.toThrow("db down");
  });
});

describe("runMutation", () => {
  const consoleError = spyOnConsoleError();

  it("returns NOT_AUTHENTICATED without running or revalidating", async () => {
    h.auth.mockResolvedValueOnce(null);
    const run = vi.fn();
    expect(await runMutation(run)).toEqual(NOT_AUTHENTICATED);
    expect(run).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("runs with the context, revalidates /schemas (layout) after success and returns the data", async () => {
    const run = vi.fn(async (ctx: { userId: string }) => ({ success: true as const, data: { by: ctx.userId } }));
    const r = await runMutation(run);
    expect(r).toEqual({ success: true, data: { by: "db-user" } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ userId: "db-user", userRole: "AUTHOR" }));
    expect(h.revalidatePath).toHaveBeenCalledTimes(1);
    expect(h.revalidatePath).toHaveBeenCalledWith("/schemas", "layout");
  });

  it("never revalidates on a service failure and carries the error contract", async () => {
    const r = await runMutation(async () => ({
      success: false as const,
      error: { code: "NAME_CONFLICT", message: "taken", details: { conflict: 1 }, suggestedFix: "Pick another" },
    }));
    expect(r).toEqual({ success: false, error: "taken", code: "NAME_CONFLICT", details: { conflict: 1 }, suggestedFix: "Pick another" });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["DB_ERROR", "INTERNAL_ERROR"])("never returns raw %s text from a mutating action: generic payload, no revalidation, original logged with the action label", async (code) => {
    const raw = "duplicate key value violates unique constraint \"messages_pkey\"";
    const r = await runMutation(
      async () => ({ success: false as const, error: { code, message: raw, details: { constraint: "messages_pkey" }, suggestedFix: "x" } }),
      "updateMessageAction"
    );
    expect(r).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code });
    expect(JSON.stringify(r)).not.toMatch(/messages_pkey|duplicate/);
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(consoleError()).toHaveBeenCalledWith(`[updateMessageAction] ${LOG_KIND[code]}`, raw);
  });

  it("logs under a default label when the action does not name itself", async () => {
    await runMutation(async () => ({ success: false as const, error: { code: "DB_ERROR", message: "x" } }));
    expect(consoleError()).toHaveBeenCalledWith("[mutation] database error", "x");
  });
});

describe("sanitizeActionError", () => {
  const consoleError = spyOnConsoleError();

  it("turns a DB_ERROR result into the generic message and logs the original server-side", async () => {
    const raw = 'relation "message_versions" does not exist';
    const r = await sanitizeActionError({ success: false, error: { code: "DB_ERROR", message: raw, details: { sql: "select 1" }, suggestedFix: "x" } }, "myAction");
    expect(r).toEqual({ success: false, error: { code: "DB_ERROR", message: GENERIC_ACTION_ERROR } });
    expect(JSON.stringify(r)).not.toContain("message_versions");
    expect(consoleError()).toHaveBeenCalledWith("[myAction] database error", raw);
  });

  it("sanitizes an INTERNAL_ERROR result exactly like a DB_ERROR one", async () => {
    const r = await sanitizeActionError({ success: false, error: { code: "INTERNAL_ERROR", message: "TypeError: x is undefined at /srv/app.js:1", suggestedFix: "x" } }, "myAction");
    expect(r).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR } });
    expect(consoleError()).toHaveBeenCalledWith("[myAction] internal error", "TypeError: x is undefined at /srv/app.js:1");
  });

  it("turns a rejected promise into a generic INTERNAL_ERROR and logs the thrown error", async () => {
    const thrown = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    const r = await sanitizeActionError(Promise.reject(thrown), "myAction");
    expect(r).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR } });
    expect(consoleError()).toHaveBeenCalledWith("[myAction] unexpected error", thrown);
  });

  it("passes successes and every other failure through untouched, keeping details and suggestedFix", async () => {
    const ok = { success: true as const, data: { id: "1" } };
    expect(await sanitizeActionError(ok)).toBe(ok);
    expect(await sanitizeActionError(Promise.resolve(ok))).toBe(ok);
    for (const code of ["PUBLISH_BLOCKED", "BUMP_TOO_LOW", "INVALID_PLAN_INPUT", "CONFLICT", "NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR"]) {
      const failure = { success: false as const, error: { code, message: `${code} text`, details: { blockers: [{ kind: "X" }] }, suggestedFix: "Do this" } };
      expect(await sanitizeActionError(failure)).toBe(failure);
    }
    expect(consoleError()).not.toHaveBeenCalled();
  });

  it("composes with toActionResult (as the events actions use them): one log line, one generic payload", async () => {
    const sanitized = await sanitizeActionError({ success: false, error: { code: "DB_ERROR", message: "raw pg text", details: { a: 1 }, suggestedFix: "f" } }, "myAction");
    expect(toActionResult(sanitized, "runMutation label")).toEqual({ success: false, error: GENERIC_ACTION_ERROR, code: "DB_ERROR" });
    expect(consoleError()).toHaveBeenCalledTimes(1);
    expect(consoleError()).toHaveBeenCalledWith("[myAction] database error", "raw pg text");
  });

  it("shares ONE implementation with toActionResult: the same Result is sanitized identically (no divergent copies)", async () => {
    const results = [
      { success: false as const, error: { code: "DB_ERROR", message: "raw", details: { a: 1 }, suggestedFix: "f" } },
      { success: false as const, error: { code: "INTERNAL_ERROR", message: "raw", details: { a: 1 }, suggestedFix: "f" } },
      { success: false as const, error: { code: "CONFLICT", message: "kept", details: { a: 1 }, suggestedFix: "f" } },
    ];
    for (const result of results) {
      const viaSanitize = await sanitizeActionError(result, "x");
      const viaAction = toActionResult(result, "x");
      if (viaSanitize.success) throw new Error("expected a failure");
      expect(viaAction).toMatchObject({ success: false, error: viaSanitize.error.message, code: viaSanitize.error.code });
      // Whatever sanitizeActionError kept (details / suggestedFix), toActionResult kept, and vice versa.
      expect("details" in viaAction).toBe("details" in viaSanitize.error);
      expect("suggestedFix" in viaAction).toBe("suggestedFix" in viaSanitize.error);
    }
  });
});
