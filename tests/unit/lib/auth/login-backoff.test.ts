import { describe, expect, it } from "vitest";
import {
  BACKOFF_FREE_FAILURES,
  BACKOFF_MAX_MS,
  BACKOFF_STEP_MS,
  BACKOFF_WINDOW_MS,
  loginBackoffMs,
  noteUnaddressedAttempt,
} from "@/lib/auth/login-backoff";

// The failures are kept per process, so each test starts a day after the one before: nothing of an earlier test is still in its window.
let day = 0;
const newDay = () => Date.UTC(2040, 0, 1) + (day++) * 24 * 60 * 60 * 1000;
const failuresAt = (count: number, at: number) => {
  for (let i = 0; i < count; i += 1) noteUnaddressedAttempt(at);
};

describe("loginBackoffMs (sign-ins without a client address)", () => {
  it("is free for the first failures of the window", () => {
    const at = newDay();
    expect(loginBackoffMs(at)).toBe(0);
    failuresAt(BACKOFF_FREE_FAILURES, at);
    expect(loginBackoffMs(at)).toBe(0);
  });

  it("grows by one step for each failure beyond the free ones, and never beyond the cap", () => {
    const at = newDay();
    failuresAt(BACKOFF_FREE_FAILURES + 1, at);
    expect(loginBackoffMs(at)).toBe(BACKOFF_STEP_MS);
    failuresAt(BACKOFF_MAX_MS / BACKOFF_STEP_MS, at);
    expect(loginBackoffMs(at)).toBe(BACKOFF_MAX_MS);
    failuresAt(10_000, at);
    expect(loginBackoffMs(at)).toBe(BACKOFF_MAX_MS);
  });

  it("counts only the failures of the last fifteen minutes", () => {
    const at = newDay();
    failuresAt(BACKOFF_FREE_FAILURES + 10, at);
    expect(loginBackoffMs(at)).toBe(10 * BACKOFF_STEP_MS);
    expect(loginBackoffMs(at + BACKOFF_WINDOW_MS - 1)).toBe(10 * BACKOFF_STEP_MS);
    expect(loginBackoffMs(at + BACKOFF_WINDOW_MS + 1)).toBe(0);
  });

  it("is bounded: no count of failures makes a sign-in wait longer than the cap", () => {
    expect(BACKOFF_MAX_MS).toBeLessThanOrEqual(5_000);
    const at = newDay();
    failuresAt(50, at);
    expect(loginBackoffMs(at)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
});
