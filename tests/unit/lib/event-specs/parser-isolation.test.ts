import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDiagnostics } from "@/lib/event-specs/diagnostics";
import { GENERIC_VALIDATION_FAILURE } from "@/lib/event-specs/validator";
import { AsyncApiParserValidator, mapParserDiagnostic } from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { createAsyncApiParser } from "@/lib/event-specs/validation/parser-core";
import { parserPoolStatus, runParserJob, shutdownParserPool, tooComplexLead } from "@/lib/event-specs/validation/parser-runner";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { Diagnostic } from "@/lib/event-specs/types";
import { goldenCases } from "./fixtures/dirty-documents";
import { hostileParametersDocument, smallDocument, yamlErrorFlood } from "./fixtures/hostile-documents";
import { lagProbe } from "./fixtures/lag-probe";

/**
 * The parser and the read of a file in a child process, through the REAL worker (`worker-dist/asyncapi-parser-worker.cjs`, built by the global
 * setup): ordinary documents give exactly the diagnostics they gave when the parser ran in the server; a document that costs the parser
 * seconds is cut at the time limit while the event loop of this process stays free.
 */

const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "asyncapi-import");
const GOLDEN = path.join(process.cwd(), "tests", "unit", "lib", "event-specs", "__golden__", "parser-validator-diagnostics.before.json");

// The worker stays warm from test to test (as in the server); a test that needs a particular pool starts from `shutdownParserPool()`.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(() => shutdownParserPool());

/** True once the process `pid` no longer exists (a SIGKILL is delivered a moment after it is sent); false if it is still there after `ms`. */
async function waitUntilGone(pid: number, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("ordinary documents give what the in-process parser gave", () => {
  /** Captured from the code BEFORE the parser ran in a worker (the in-process validator of the base commit), on 10 ordinary fixtures, each with and without one defect. */
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
  const cases = goldenCases();

  it("the golden file covers every case, and the cases hold real errors and warnings (not only the advice about the latest version)", () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort());
    const severities = new Set(Object.values(golden).flatMap((v) => (Array.isArray(v) ? (v as Diagnostic[]).map((d) => d.severity) : [])));
    expect(severities).toEqual(new Set(["error", "warning", "info"]));
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases.map((c) => [c.name, c] as const))("AsyncApiParserValidator: %s", async (name, { document }) => {
    const res = await new AsyncApiParserValidator().validate(structuredClone(document));
    expect(res.success ? res.data : { error: res.error }).toEqual(golden[name]);
  });

  it("the importer's parser verdict (importValidate) maps to the same diagnostics as the parser run directly, on every ordinary fixture", async () => {
    const direct = createAsyncApiParser();
    const names = readdirSync(FIXTURES).filter((n) => !n.startsWith("negative-"));
    expect(names.length).toBe(10);
    for (const name of names) {
      const parsed = parseAsyncApiSource(readFileSync(path.join(FIXTURES, name), "utf8"));
      if (!parsed.success) throw new Error(`${name}: ${parsed.error.message}`);
      const viaWorker = await runParserJob({ kind: "importValidate", document: parsed.data });
      if (!viaWorker.success) throw new Error(`${name}: ${viaWorker.error.code}`);
      expect(normalizeDiagnostics(viaWorker.data.diagnostics.map(mapParserDiagnostic)), name).toEqual(normalizeDiagnostics((await direct.validate(parsed.data)).map(mapParserDiagnostic)));
    }
  }, 60_000); // the parser is built twice (here and in the worker) and run 20 times, cold

  it("the read of a file (parseSource) answers exactly what parseAsyncApiSource answers in process, errors included (every fixture, negative ones too)", async () => {
    for (const name of readdirSync(FIXTURES)) {
      const text = readFileSync(path.join(FIXTURES, name), "utf8");
      const viaWorker = await runParserJob({ kind: "parseSource", text });
      expect(viaWorker, name).toEqual({ success: true, data: parseAsyncApiSource(text) });
    }
    for (const text of ["", "   \n", "{", "a: [", "- 1\n- 2", "asyncapi: 2.6.0\n", "just words", `{"a":1,"a":2}`]) {
      expect(await runParserJob({ kind: "parseSource", text }), JSON.stringify(text)).toEqual({ success: true, data: parseAsyncApiSource(text) });
    }
  });
});

describe("a document that blocks the parser for seconds", () => {
  beforeEach(() => {
    shutdownParserPool();
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", "1");
  });
  it("is cut at the time limit (PARSER_TIMEOUT, an error diagnostic), the event loop of this process stays free, and the next document validates", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS", "2000");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const validator = new AsyncApiParserValidator();
    expect((await validator.validate(smallDocument())).success).toBe(true); // a warm worker: the probe measures the hostile job only
    const hostile = hostileParametersDocument(); // built before the probe starts
    const pid = parserPoolStatus().workers[0].pid as number;

    const probe = lagProbe();
    const started = Date.now();
    const res = await validator.validate(hostile);
    const took = Date.now() - started;
    const lag = probe.stop();

    expect(res).toEqual({
      success: true,
      data: [{
        severity: "error", code: "PARSER_TIMEOUT", pointer: "",
        message: "This document is too complex to validate here: the check took longer than 2 seconds and was stopped. Split it into smaller events, or remove the unusually large parts.",
      }],
    });
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(8_000); // loose for a loaded machine: unblocked, the parser alone needs 8 - 13 s
    expect(lag).toBeLessThan(200); // in process the same document held the loop for 9 - 13 s
    expect(await waitUntilGone(pid)).toBe(true); // the worker that held it is dead

    const next = await validator.validate(smallDocument("Next"));
    expect(next.success && next.data.filter((d) => d.severity === "error")).toEqual([]);
  }, 60_000);

  it("a flood of YAML syntax errors is cut by parseSource at its limit, and the event loop stays free", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const flood = yamlErrorFlood();
    const probe = lagProbe();
    const started = Date.now();
    const res = await runParserJob({ kind: "parseSource", text: flood }, { timeoutMs: 1_500 });
    const took = Date.now() - started;
    const lag = probe.stop();
    expect(res).toMatchObject({ success: false, error: { code: "PARSER_TIMEOUT", details: { timeoutMs: 1_500 } } });
    expect(took).toBeGreaterThanOrEqual(1_400);
    expect(took).toBeLessThan(7_000); // loose for a loaded machine: the limit is 1.5 s, the unbounded read 5 - 9 s
    expect(lag).toBeLessThan(200);
    // and the pool is fine afterwards
    expect(await runParserJob({ kind: "parseSource", text: "asyncapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\n" })).toMatchObject({ success: true, data: { success: true } });
  }, 60_000);

  it("a result over the message limit is refused cleanly (PARSER_TOO_LARGE diagnostic), not truncated and not a crash", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_MAX_MESSAGE_BYTES", "10000");
    const validator = new AsyncApiParserValidator();
    expect((await validator.validate(smallDocument())).success).toBe(true); // a small answer fits
    // a document well under the limit (about 7 KB) whose problems (a dangling reference in each of 100 channels) are not (about 15 KB)
    const channels = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`c${i}`, { messages: { m: { $ref: `#/components/messages/missing${i}` } } }]));
    const document = { asyncapi: "3.0.0", info: { title: "t", version: "1" }, channels };
    expect(JSON.stringify(document).length).toBeLessThan(10_000);
    expect(await runParserJob({ kind: "validate", document })).toMatchObject({ success: false, error: { code: "PARSER_MESSAGE_TOO_LARGE", details: { direction: "from-worker", limitBytes: 10_000 } } });
    expect(await validator.validate(document)).toEqual({
      success: true,
      data: [{ severity: "error", code: "PARSER_TOO_LARGE", pointer: "", message: "This document is too large, or has too many problems, to validate here. Split it into smaller events, or remove the unusually large parts." }],
    });
  });
});

describe("what the validator makes of the runner's other failures (a fake worker)", () => {
  let dir: string;
  let fake: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "parser-isolation-"));
    fake = path.join(dir, "fake-worker.cjs");
    writeFileSync(fake, `
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  if (process.env.FAKE_MODE === "hang") for (;;) {}
  if (process.env.FAKE_MODE === "crash") process.exit(1);
  setTimeout(() => process.send({ type: "result", id: message.id, body: JSON.stringify({ parser: [], extra: [] }) }), Number(process.env.FAKE_HOLD_MS || 0));
});
process.send({ type: "ready", pid: process.pid });
`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // a warm worker is reused whatever file it came from: start each test from an empty pool, and leave none of the fake ones behind
  beforeEach(() => shutdownParserPool());
  afterEach(() => shutdownParserPool());
  const useFake = (mode: string, workers = 1) => {
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", fake);
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", String(workers));
    vi.stubEnv("FAKE_MODE", mode);
  };

  it("the time limit in the message is the one used (0.2 seconds here; the defaults are 15 s and 4 s)", async () => {
    useFake("hang");
    vi.stubEnv("ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS", "200");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await new AsyncApiParserValidator().validate(smallDocument());
    expect(res).toMatchObject({ success: true, data: [{ code: "PARSER_TIMEOUT", message: `${tooComplexLead(200)} Split it into smaller events, or remove the unusually large parts.` }] });
    expect(tooComplexLead(200)).toContain("longer than 0.2 seconds");
    expect(tooComplexLead(15_000)).toContain("longer than 15 seconds");
    expect(tooComplexLead(1_500)).toContain("longer than 1.5 seconds");
  });

  it("too many documents at once: those beyond the queue are PARSER_BUSY diagnostics (an error: publish stays blocked), the others are served", async () => {
    useFake("hold");
    vi.stubEnv("FAKE_HOLD_MS", "10");
    const validator = new AsyncApiParserValidator();
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => validator.validate(smallDocument(`Doc ${i}`))));
    const busy = results.filter((r) => r.success && r.data.some((d) => d.code === "PARSER_BUSY"));
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r).toEqual({ success: true, data: [{ severity: "error", code: "PARSER_BUSY", pointer: "", message: "The validator is busy with other documents. Try again in a moment." }] });
    }
    expect(results.length - busy.length).toBeGreaterThanOrEqual(20); // one running and 20 waiting were served
    for (const r of results) expect(r.success).toBe(true);
  });

  it("a worker that crashes is the generic failure of the validator (ASYNCAPI_PARSER_FAILED), logged, never the cause", async () => {
    useFake("crash");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await new AsyncApiParserValidator().validate(smallDocument());
    expect(res).toEqual({ success: false, error: { code: "ASYNCAPI_PARSER_FAILED", message: GENERIC_VALIDATION_FAILURE } });
    expect(logged).toHaveBeenCalled();
  });

  it("a missing worker file is the same generic failure (fail closed): the parser is NOT run in this process", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", path.join(dir, "missing.cjs"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await new AsyncApiParserValidator().validate(smallDocument());
    expect(res).toEqual({ success: false, error: { code: "ASYNCAPI_PARSER_FAILED", message: GENERIC_VALIDATION_FAILURE } });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("npm run build:parser-worker"));
  });
});
