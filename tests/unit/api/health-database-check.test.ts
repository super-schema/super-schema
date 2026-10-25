// @vitest-environment node
/**
 * The health probe (GET /api/v1/health, no login). A monitor calls it, so:
 *   - the database round trip is bounded: a DB that answers slowly is "degraded" (HTTP 200), one that fails or does not answer within
 *     the timeout is "unhealthy" (HTTP 503), and a hung DB fails the probe within the timeout instead of hanging it;
 *   - thresholds are settings: HEALTH_DB_DEGRADED_MS (default 500) and HEALTH_DB_TIMEOUT_MS (default 5000);
 *   - nothing of the database's own error (host, user, password in a connection string) is in the answer: a generic message, and the
 *     real error in the server's log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: (...args: unknown[]) => mocks.queryRaw(...args) } }));

import { GET } from "@/app/api/v1/health/route";
import { _resetHealthStore } from "@/services/health.service";

const RAW = "connect ECONNREFUSED 10.0.0.5:5432 (user=superschema password=hunter2)";
const answerAfter = (ms: number) => new Promise((resolve) => setTimeout(() => resolve([{ "?column?": 1 }]), ms));

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  _resetHealthStore();
  mocks.queryRaw.mockReset();
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.HEALTH_DB_DEGRADED_MS;
  delete process.env.HEALTH_DB_TIMEOUT_MS;
});
afterEach(() => {
  vi.useRealTimers();
  logged.mockRestore();
  delete process.env.HEALTH_DB_DEGRADED_MS;
  delete process.env.HEALTH_DB_TIMEOUT_MS;
});

/** Runs the endpoint with the fake clock moving by `advance` ms while it waits. */
async function probe(advance = 0) {
  const pending = GET();
  await vi.advanceTimersByTimeAsync(advance);
  const response = await pending;
  return { status: response.status, body: await response.json() };
}

describe("GET /api/v1/health: the database", () => {
  it("a fast database is healthy: 200", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { status, body } = await probe();
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.components.database.status).toBe("healthy");
    expect(typeof body.timestamp).toBe("string");
    expect(Object.keys(body.components).sort()).toEqual(["compiler", "database", "emitters"]);
  });

  it("a database that answers, but slowly (500 ms or more), is degraded, and the answer is still 200", async () => {
    mocks.queryRaw.mockImplementation(() => answerAfter(700));
    const { status, body } = await probe(700);
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.components.database.status).toBe("degraded");
    expect(body.components.database.latencyMs).toBeGreaterThanOrEqual(700);
  });

  it("a database that is just under the threshold is healthy", async () => {
    mocks.queryRaw.mockImplementation(() => answerAfter(499));
    const { status, body } = await probe(499);
    expect(status).toBe(200);
    expect(body.components.database.status).toBe("healthy");
  });

  it("a failing database is unhealthy: 503, with a generic message and no raw error in the answer", async () => {
    mocks.queryRaw.mockRejectedValue(new Error(RAW));
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.components.database.status).toBe("unhealthy");
    expect(body.components.database.message).toBe("Database unavailable");
    const everything = JSON.stringify(body);
    expect(everything).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|hunter2|superschema/);
    // The real error is in the server's log.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("[health]"), expect.objectContaining({ message: RAW }));
  });

  it("a database that hangs fails the probe within the timeout (5000 ms by default): 503", async () => {
    mocks.queryRaw.mockImplementation(() => new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(4999);
    // Still waiting just before the timeout ...
    const state = await Promise.race([pending.then(() => "answered"), Promise.resolve("waiting")]);
    expect(state).toBe("waiting");
    await vi.advanceTimersByTimeAsync(2);
    const response = await pending;
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.components.database.status).toBe("unhealthy");
    expect(body.components.database.message).toBe("Database did not answer in time");
  });

  it("an answer that comes after the timeout is still a failure, and the late answer does not matter", async () => {
    process.env.HEALTH_DB_TIMEOUT_MS = "1000";
    mocks.queryRaw.mockImplementation(() => answerAfter(3000));
    const { status, body } = await probe(1000);
    expect(status).toBe(503);
    expect(body.components.database.message).toBe("Database did not answer in time");
    // Running out the late answer must not raise an unhandled rejection or change anything.
    await vi.advanceTimersByTimeAsync(5000);
  });

  it("a late REJECTION after the timeout is handled, not an unhandled rejection", async () => {
    process.env.HEALTH_DB_TIMEOUT_MS = "1000";
    mocks.queryRaw.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error(RAW)), 3000)));
    const { status } = await probe(1000);
    expect(status).toBe(503);
    await vi.advanceTimersByTimeAsync(5000);
  });

  it("the thresholds are settings: HEALTH_DB_DEGRADED_MS and HEALTH_DB_TIMEOUT_MS", async () => {
    process.env.HEALTH_DB_DEGRADED_MS = "50";
    process.env.HEALTH_DB_TIMEOUT_MS = "2000";
    mocks.queryRaw.mockImplementation(() => answerAfter(60));
    expect((await probe(60)).body.components.database.status).toBe("degraded");

    _resetHealthStore(); // the answer of the database check is cached for 5 s (below): each case here is a fresh probe
    mocks.queryRaw.mockImplementation(() => answerAfter(30));
    expect((await probe(30)).body.components.database.status).toBe("healthy");

    _resetHealthStore();
    mocks.queryRaw.mockImplementation(() => new Promise(() => {}));
    const { status } = await probe(2000);
    expect(status).toBe(503);
  });

  it.each(["", "abc", "-5", "0", "NaN"])("a setting that is not a positive number (%j) is the default", async (value) => {
    process.env.HEALTH_DB_DEGRADED_MS = value;
    process.env.HEALTH_DB_TIMEOUT_MS = value;
    mocks.queryRaw.mockImplementation(() => answerAfter(600));
    const { status, body } = await probe(600);
    expect(status).toBe(200);
    expect(body.components.database.status).toBe("degraded");
  });

  it("does not leak the raw message of any component checker either", async () => {
    const { _setCompilerChecker, _setEmitterChecker } = await import("@/services/health.service");
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    _setCompilerChecker(async () => {
      throw new Error("ENOENT /srv/app/node_modules/@typespec/compiler secret-path");
    });
    _setEmitterChecker(async () => {
      throw new Error("emitter token=abc123 refused");
    });
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/ENOENT|secret-path|abc123|node_modules/);
    expect(body.components.compiler.message).toBe("Compiler check failed");
    expect(body.components.emitters.message).toBe("Emitter check failed");
  });
});

describe("GET /api/v1/health: the database check is cached for 5 seconds", () => {
  it("answers a second call within 5 s from the first one's result: one SELECT 1, however often a monitor calls", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const first = await probe();
    for (let i = 0; i < 20; i += 1) await probe(200); // 20 calls over 4 s
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(first.body.components.database.status).toBe("healthy");
  });

  it("asks again once the 5 s are over, and not before", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    await probe();
    await vi.advanceTimersByTimeAsync(4999);
    await probe();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await probe();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("calls at the same moment share ONE query (the second does not wait for another round trip)", async () => {
    mocks.queryRaw.mockImplementation(() => answerAfter(100));
    const pending = [GET(), GET(), GET(), GET()];
    await vi.advanceTimersByTimeAsync(100);
    const answers = await Promise.all(pending);
    expect(answers.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("caches a failure too (a sick database is not hit by every call, and its error is logged once per 5 s), and recovers on the next window", async () => {
    mocks.queryRaw.mockRejectedValue(new Error(RAW));
    expect((await probe()).status).toBe(503);
    expect((await probe(100)).status).toBe(503);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await probe()).status).toBe(200);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("_resetHealthStore forgets the cached answer (a test, or a deployment that wants a fresh check, starts clean)", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    await probe();
    _resetHealthStore();
    await probe();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });
});
