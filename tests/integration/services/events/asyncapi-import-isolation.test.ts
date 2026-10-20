import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownParserPool, tooComplexLead } from "@/lib/event-specs/validation/parser-runner";
import { importAsyncApi, previewAsyncApiImport } from "@/services/events/asyncapi-import.service";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import type { Result } from "@/types/result";
import { hostileParametersText, yamlErrorFlood } from "../../../unit/lib/event-specs/fixtures/hostile-documents";
import { lagProbe } from "../../../unit/lib/event-specs/fixtures/lag-probe";
import { cleanupDomains, connectTestDb, createProductScope, testContext } from "./helpers";

/**
 * The importer when the parser or the read of the file is cut at its time limit, with the REAL worker: a clean `VALIDATION_ERROR` (plain text,
 * nothing from the document), nothing created, quickly, the event loop free meanwhile, and the next import works. (The ordinary imports are the
 * big suite `asyncapi-import.service.test.ts`; this file is the part that needs a document the parser cannot digest.)
 */
const prisma = connectTestDb();
const domainIds: string[] = [];
afterAll(async () => {
  shutdownParserPool();
  await cleanupDomains(prisma, domainIds);
  await prisma.$disconnect();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setup() {
  const ctx = await testContext(prisma);
  const scope = await createProductScope(prisma, ctx, "iso");
  domainIds.push(scope.domain.id);
  return { ctx, productId: scope.product.id };
}
const inventory = async (productId: string) => ({
  entities: await prisma.entity.count({ where: { productId } }),
  events: await prisma.eventSpec.count({ where: { productId } }),
});
const failure = <T>(r: Result<T>) => (r.success ? null : r.error);
const ordinary = readFileSync(path.join(process.cwd(), "tests", "fixtures", "asyncapi-import", "request-reply.yaml"), "utf8");

describe("a file the parser cannot digest in time", () => {
  beforeEach(() => {
    shutdownParserPool();
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", "1");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("60 channels of 1,999 parameters (about 1 MiB, passes every cap): the preview and the import are refused 'too complex', within about 3 s, nothing created, the loop free", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS", "2000");
    const { ctx, productId } = await setup();
    const content = hostileParametersText();
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024);
    // a warm worker, so the clock below is the hostile job and not the start of the worker
    expect(failure(await previewAsyncApiImport(productId, { content: ordinary }, ctx))).toBeNull();
    const before = await inventory(productId);

    const probe = lagProbe();
    const started = Date.now();
    const previewed = await previewAsyncApiImport(productId, { content }, ctx);
    const took = Date.now() - started;
    const lag = probe.stop();

    expect(failure(previewed)).toEqual({
      code: "VALIDATION_ERROR",
      message: tooComplexLead(2_000),
      suggestedFix: "Split it into smaller events, or remove the unusually large parts, and import it again.",
    });
    expect(failure(previewed)?.message).toBe("This document is too complex to validate here: the check took longer than 2 seconds and was stopped.");
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(8_000); // loose for a loaded machine: the limit is 2 s, the unbounded parser 8 - 13 s
    expect(lag).toBeLessThan(200);

    const imported = await importAsyncApi(productId, { content }, ctx);
    expect(failure(imported)).toMatchObject({ code: "VALIDATION_ERROR", message: tooComplexLead(2_000) });
    expect(await inventory(productId)).toEqual(before); // nothing before the first write

    // the pool recovered: an ordinary document imports
    const next = await importAsyncApi(productId, { content: ordinary }, ctx);
    expect(failure(next)).toBeNull();
  }, 60_000);

  it("a flood of YAML syntax errors (1,000,000 `]`): refused 'takes too long to read' at the read limit, with fixed text, nothing created, the loop free", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_PARSE_TIMEOUT_MS", "1500");
    const { ctx, productId } = await setup();
    const content = yamlErrorFlood();
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1024 * 1024);
    expect(failure(await previewAsyncApiImport(productId, { content: ordinary }, ctx))).toBeNull();
    const before = await inventory(productId);

    const probe = lagProbe();
    const started = Date.now();
    const previewed = await previewAsyncApiImport(productId, { content }, ctx);
    const took = Date.now() - started;
    const lag = probe.stop();

    expect(failure(previewed)).toEqual({
      code: "VALIDATION_ERROR",
      message: "This file takes too long to read (it may contain a very large number of syntax errors). Check that it is valid YAML or JSON and import it again.",
    });
    expect(took).toBeGreaterThanOrEqual(1_400);
    expect(took).toBeLessThan(7_000); // loose for a loaded machine: the limit is 1.5 s, the unbounded read 5 - 9 s
    expect(lag).toBeLessThan(200);
    expect(failure(await importAsyncApi(productId, { content }, ctx))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await inventory(productId)).toEqual(before);
    expect(failure(await previewAsyncApiImport(productId, { content: ordinary }, ctx))).toBeNull(); // and the next file reads fine
  }, 60_000);
});

describe("the runner's other failures, as the importer reports them (a fake worker)", () => {
  let dir: string;
  let fake: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "import-isolation-"));
    fake = path.join(dir, "fake-worker.cjs");
    writeFileSync(fake, `
process.on("disconnect", () => process.exit(0));
process.on("message", (message) => {
  if (process.env.FAKE_MODE === "crash") process.exit(1);
  // answers every job as "the file is not YAML", after a short hold
  setTimeout(() => process.send({ type: "result", id: message.id, body: JSON.stringify({ success: false, error: { code: "PARSE_ERROR", message: "held" } }) }), 40);
});
process.send({ type: "ready", pid: process.pid });
`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => shutdownParserPool());
  afterEach(() => shutdownParserPool());

  it("a busy pool is a VALIDATION_ERROR 'The validator is busy. Try again in a moment.' (a plain message the dialog shows), nothing created", async () => {
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", fake);
    vi.stubEnv("ASYNCAPI_PARSER_WORKERS", "1");
    const { ctx, productId } = await setup();
    const results = await Promise.all(Array.from({ length: 26 }, () => previewAsyncApiImport(productId, { content: ordinary }, ctx)));
    const busy = results.filter((r) => failure(r)?.message === "The validator is busy. Try again in a moment.");
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) expect(failure(r)).toEqual({ code: "VALIDATION_ERROR", message: "The validator is busy. Try again in a moment." });
    expect(results.filter((r) => failure(r)?.message === "held").length).toBeGreaterThan(0); // the others were served (the fake's answer)
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 60_000);

  it("a crashed or missing worker is the generic INTERNAL_ERROR (its cause only in the log), never a VALIDATION_ERROR a user could misread", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ctx, productId } = await setup();

    vi.stubEnv("ASYNCAPI_PARSER_WORKER", fake);
    vi.stubEnv("FAKE_MODE", "crash");
    expect(failure(await previewAsyncApiImport(productId, { content: ordinary }, ctx))).toEqual({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });

    shutdownParserPool();
    vi.stubEnv("ASYNCAPI_PARSER_WORKER", path.join(dir, "missing.cjs"));
    expect(failure(await previewAsyncApiImport(productId, { content: ordinary }, ctx))).toEqual({ code: "INTERNAL_ERROR", message: GENERIC_ACTION_ERROR });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("npm run build:parser-worker"));
    expect(await inventory(productId)).toEqual({ entities: 0, events: 0 });
  }, 60_000);
});
