import { describe, expect, it } from "vitest";
import { ImportLimiter } from "@/lib/importers/import-limiter";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ImportLimiter: concurrency", () => {
  it("refuses a start beyond the process-wide limit with a 'busy, retry' answer, and a release frees the slot", () => {
    const limiter = new ImportLimiter({ maxConcurrent: 2, perUserLimit: 100 });
    const a = limiter.acquire("u1");
    const b = limiter.acquire("u2");
    expect(a.ok && b.ok).toBe(true);
    const c = limiter.acquire("u3");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe("busy");
      expect(c.message).toMatch(/busy|too many imports/i);
      expect(c.retryAfterMs).toBeGreaterThan(0);
    }
    expect(limiter.active).toBe(2);
    if (a.ok) a.release();
    expect(limiter.active).toBe(1);
    expect(limiter.acquire("u3").ok).toBe(true);
  });

  it("a release is idempotent: releasing twice never frees a slot that belongs to someone else", () => {
    const limiter = new ImportLimiter({ maxConcurrent: 1, perUserLimit: 100 });
    const a = limiter.acquire("u1");
    if (!a.ok) throw new Error("expected a slot");
    a.release();
    const b = limiter.acquire("u2");
    expect(b.ok).toBe(true);
    a.release(); // a second release of the FIRST slot must not free the second one
    expect(limiter.active).toBe(1);
    expect(limiter.acquire("u3").ok).toBe(false);
  });
});

describe("ImportLimiter: per-user sliding window", () => {
  it("allows the limit within the window, refuses the next with the time to wait, and allows again as the window slides", () => {
    const c = clock();
    const limiter = new ImportLimiter({ maxConcurrent: 100, perUserLimit: 10, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 10; i++) {
      const s = limiter.acquire("u1");
      expect(s.ok).toBe(true);
      if (s.ok) s.release();
      c.advance(1_000); // 10 starts at t = 0..9 s
    }
    // t = 10 s: the window holds ten starts
    const refused = limiter.acquire("u1");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("rate");
      // the oldest start (t = 0) leaves the window at t = 60 s: 50 s from now
      expect(refused.retryAfterMs).toBe(50_000);
      expect(refused.message).toMatch(/50 seconds/);
    }
    // sliding, not a fixed minute: at t = 60.5 s only the first start has left the window, so exactly one more is allowed
    c.advance(50_500);
    const again = limiter.acquire("u1");
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
    expect(limiter.acquire("u1").ok).toBe(false);
  });

  it("users are independent", () => {
    const limiter = new ImportLimiter({ maxConcurrent: 100, perUserLimit: 1 });
    expect(limiter.acquire("u1").ok).toBe(true);
    expect(limiter.acquire("u1").ok).toBe(false);
    expect(limiter.acquire("u2").ok).toBe(true);
  });

  it("a refused attempt is not recorded: a user turned away as busy still has the whole window, and waiting out a rate refusal is enough", () => {
    const c = clock();
    const limiter = new ImportLimiter({ maxConcurrent: 1, perUserLimit: 2, windowMs: 60_000, now: c.now });
    const first = limiter.acquire("other");
    for (let i = 0; i < 5; i++) expect(limiter.acquire("u1")).toMatchObject({ ok: false, reason: "busy" });
    if (first.ok) first.release();
    // five busy refusals consumed nothing: u1 still has two starts
    const s1 = limiter.acquire("u1");
    if (s1.ok) s1.release();
    const s2 = limiter.acquire("u1");
    if (s2.ok) s2.release();
    expect(limiter.acquire("u1")).toMatchObject({ ok: false, reason: "rate" });
    for (let i = 0; i < 5; i++) expect(limiter.acquire("u1")).toMatchObject({ ok: false, reason: "rate" });
    c.advance(60_001);
    expect(limiter.acquire("u1").ok).toBe(true);
  });

  it("forgets users whose window has passed (the map cannot grow without bound)", () => {
    const c = clock();
    const limiter = new ImportLimiter({ maxConcurrent: 1000, perUserLimit: 5, windowMs: 60_000, now: c.now, sweepAbove: 50 });
    for (let i = 0; i < 200; i++) {
      const s = limiter.acquire(`user-${i}`);
      if (s.ok) s.release();
    }
    expect(limiter.trackedUsers).toBeGreaterThan(50);
    c.advance(61_000);
    const s = limiter.acquire("fresh");
    if (s.ok) s.release();
    expect(limiter.trackedUsers).toBeLessThanOrEqual(2);
  });
});
