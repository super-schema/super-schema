// src/lib/event-specs/validation/parser-runner.ts
// Runs the AsyncAPI parser, and the importer's read of a YAML / JSON file, in a WARM CHILD PROCESS with a hard timeout, so that a hostile
// document cannot block the Node server.
//
// Why: `@asyncapi/parser` is synchronous Spectral, and the `yaml` package takes seconds on a file that is mostly syntax errors. A document of
// about 1 MiB that passes every size cap still blocked the event loop for about 10 s (60 channels of 1,999 `parameters` entries: 9.4 s; a file of
// `]` characters: 6.3 s), and no cap can bound it (the cost per entry varies by 100x with the shape). Code that is running cannot be interrupted
// in its own process, but a process can be killed: that is the only real bound, so the work runs in a child.
//
//   const answer = await runParserJob({ kind: "validate", document });          // Result<ValidateJobResult>
//   const parsed = await runParserJob({ kind: "parseSource", text }, { timeoutMs: 2_000 });
//
// Never throws: the answer is a `Result`. A failure of the RUNNER has one of these codes (a document's own problems are in the answers):
//   PARSER_TIMEOUT      the job took longer than its timeout; the worker was killed (`details.timeoutMs`);
//   PARSER_BUSY         the queue is full, or the job waited too long for a free worker;
//   PARSER_CRASHED      the worker ended, failed to start or sent nonsense while it held the job (the cause is in the server log, never in the Result);
//   PARSER_JOB_FAILED   the parser itself threw (the exception is in the server log);
//   PARSER_MESSAGE_TOO_LARGE  the job, or its answer, is over 8 MiB (`details.direction`);
//   PARSER_BAD_JOB      the document cannot be written as JSON (a cycle, a BigInt);
//   PARSER_UNAVAILABLE  the worker file is missing (build it: `npm run build:parser-worker`) or the pool was shut down. FAIL CLOSED: the parser
//                       is never run in the server's process because a file is missing.
//
// Pool: up to `ASYNCAPI_PARSER_WORKERS` workers (default 2, 1 - 4), spawned lazily and kept warm (the parser is built before a worker says it is
// ready, about 0.3 s after its start); one job per worker at a time; the others wait in a FIFO queue of at most 20 jobs (a job that waits for a
// worker that is still starting counts) for at most 30 s: beyond either, `PARSER_BUSY`. The timeout runs from the moment a job is SENT to a ready
// worker (defaults: 15 s `validate` and `importValidate`, 4 s `parseSource`; `options.timeoutMs`, or `ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS` /
// `ASYNCAPI_PARSER_PARSE_TIMEOUT_MS`). On a timeout the worker gets SIGKILL and a fresh one is started when the next job needs it. A worker has
// `--max-old-space-size=768`; a worker that runs out of memory is a crash like any other. Each way, a message is at most 8 MiB
// (`ASYNCAPI_PARSER_MAX_MESSAGE_BYTES` lowers it, for tests); a worker that is not ready after 20 s is given up on
// (`ASYNCAPI_PARSER_START_TIMEOUT_MS`, for tests).
//
// No leaks: a worker exits by itself when its channel to the server closes (a server killed with SIGKILL leaves no orphan, once the worker's
// current job is over), the server kills its workers when it exits, and idle workers and their channel are `unref()`ed, so they never keep the
// server alive. The pool lives on `globalThis`, so Next's hot reload (which evaluates this module again) does not start a second one.
//
// The worker is `worker-dist/asyncapi-parser-worker.cjs`, built from `parser-worker.ts` by `npm run build:parser-worker` (it runs before `dev` and
// `build`; vitest builds it in its global setup). Looked for in this order: the file named by `ASYNCAPI_PARSER_WORKER` (when set, only that one),
// then `<working directory>/worker-dist/asyncapi-parser-worker.cjs`. `next build` ships it in the standalone output (`outputFileTracingIncludes`).
// After a change to the parser code, build it again: a running worker is the old code.
//
// Debugging escape hatch, OFF by default: `ASYNCAPI_PARSER_IN_PROCESS=1` runs the jobs in THIS process, with no timeout and nothing to kill. It is
// for stepping through the parser and for tests that replace the parser (`vi.spyOn(Parser.prototype, ...)`): never set it on a server.
import "server-only";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "@/types/result";
import { maxMessageBytes, type FromWorker, type JobResults, type ParserJobKind, type ToWorker, type WireJob } from "./parser-job";

export type ParserJob =
  | { kind: "validate"; document: object }
  | { kind: "importValidate"; document: object }
  | { kind: "parseSource"; text: string };

export interface RunParserJobOptions {
  /** Longest the job may run once a worker has it, in ms (default by kind, see the header). */
  timeoutMs?: number;
  /** Most jobs that may wait for a free worker, this one included (default 20). */
  maxQueued?: number;
  /** Longest this job may wait for a free worker, in ms (default 30,000). */
  maxWaitMs?: number;
}

export const WORKER_FILE_NAME = "asyncapi-parser-worker.cjs";
export const DEFAULT_TIMEOUT_MS: Record<ParserJobKind, number> = { validate: 15_000, importValidate: 15_000, parseSource: 4_000 };
const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUED = 20;
const DEFAULT_MAX_WAIT_MS = 30_000;
/** How long a worker may take to start (load its file, build the parser) before it is given up on. */
const DEFAULT_START_TIMEOUT_MS = 20_000;
const WORKER_MAX_OLD_SPACE_MB = 768;

const FIX = 'build it with "npm run build:parser-worker"';

const fail = (code: string, message: string, details?: object): Result<never> => err({ code, message, ...(details && { details }) });
const GENERIC = "The AsyncAPI parser worker could not run this job.";

function positiveNumber(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
function poolSize(): number {
  const n = Number(process.env.ASYNCAPI_PARSER_WORKERS);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_WORKERS) : DEFAULT_WORKERS;
}
function timeoutFor(kind: ParserJobKind, options: RunParserJobOptions): number {
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) return options.timeoutMs;
  const fromEnv = positiveNumber(kind === "parseSource" ? "ASYNCAPI_PARSER_PARSE_TIMEOUT_MS" : "ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS");
  return fromEnv ?? DEFAULT_TIMEOUT_MS[kind];
}

// ── Pool state (on globalThis) ───────────────────────────────────────────────────────────────────────────────────────────

interface QueuedJob {
  id: number;
  kind: ParserJobKind;
  wire: WireJob;
  timeoutMs: number;
  settled: boolean;
  resolve: (result: Result<unknown>) => void;
  waitTimer: NodeJS.Timeout | null;
}
interface Active { job: QueuedJob; timer: NodeJS.Timeout }
interface Slot {
  proc: ChildProcess;
  state: "starting" | "idle" | "busy" | "gone";
  active: Active | null;
  startTimer: NodeJS.Timeout | null;
}
interface PoolState { slots: Set<Slot>; queue: QueuedJob[]; nextId: number; exitHooked: boolean }

const POOL_KEY = Symbol.for("super-schema.asyncapi-parser-pool");
function pool(): PoolState {
  const holder = globalThis as unknown as Record<symbol, PoolState | undefined>;
  return (holder[POOL_KEY] ??= { slots: new Set(), queue: [], nextId: 1, exitHooked: false });
}

/** What is running now, for tests and diagnostics. */
export function parserPoolStatus(): { workers: Array<{ pid: number | undefined; state: string }>; queued: number } {
  const state = pool();
  return { workers: [...state.slots].map((slot) => ({ pid: slot.proc.pid, state: slot.state })), queued: state.queue.length };
}

function settle(job: QueuedJob, result: Result<unknown>): void {
  if (job.settled) return;
  job.settled = true;
  if (job.waitTimer) clearTimeout(job.waitTimer);
  job.resolve(result);
}

function retire(state: PoolState, slot: Slot): void {
  slot.state = "gone";
  state.slots.delete(slot);
  if (slot.startTimer) clearTimeout(slot.startTimer);
  try {
    slot.proc.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** Stops every worker now. Queued and running jobs are answered `PARSER_UNAVAILABLE`. The next job starts a new worker. */
export function shutdownParserPool(): void {
  const state = pool();
  for (const slot of [...state.slots]) {
    const active = slot.active;
    slot.active = null;
    retire(state, slot);
    if (active) {
      clearTimeout(active.timer);
      settle(active.job, fail("PARSER_UNAVAILABLE", GENERIC));
    }
  }
  for (const job of state.queue.splice(0)) settle(job, fail("PARSER_UNAVAILABLE", GENERIC));
}

// ── Worker file ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the worker file is, or why it is not: the explicit setting is the only candidate when it is set. */
function locateWorker(): { file: string } | { problem: string } {
  const configured = process.env.ASYNCAPI_PARSER_WORKER;
  const file = configured ? path.resolve(configured) : path.join(/* turbopackIgnore: true */ process.cwd(), "worker-dist", WORKER_FILE_NAME);
  if (existsSync(file)) return { file };
  return { problem: `the parser worker file is missing (${file}); ${FIX}${configured ? "" : " (ASYNCAPI_PARSER_WORKER names another place)"}` };
}

// ── Starting, feeding and losing workers ──────────────────────────────────────────────────────────────────────────────────

function spawnSlot(state: PoolState, file: string): void {
  let proc: ChildProcess;
  try {
    proc = fork(file, [], {
      execArgv: [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`],
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
  } catch (cause) {
    console.error("[asyncapi-parser] the parser worker could not be started:", cause);
    rejectQueued(state, "could not start");
    return;
  }
  const slot: Slot = { proc, state: "starting", active: null, startTimer: null };
  state.slots.add(slot);
  proc.unref();
  proc.channel?.unref();
  slot.startTimer = setTimeout(() => lose(state, slot, `it did not become ready within ${positiveNumber("ASYNCAPI_PARSER_START_TIMEOUT_MS") ?? DEFAULT_START_TIMEOUT_MS} ms`), positiveNumber("ASYNCAPI_PARSER_START_TIMEOUT_MS") ?? DEFAULT_START_TIMEOUT_MS);
  proc.on("message", (message) => onMessage(state, slot, message as FromWorker));
  proc.on("exit", (code, signal) => lose(state, slot, `it ended (code ${code}, signal ${signal})`));
  // A crashed worker closes its channel just before its `exit` event, which has the code and the signal: give it a moment, for the log.
  proc.on("disconnect", () => void setTimeout(() => lose(state, slot, "its channel closed"), 100).unref());
  proc.on("error", (cause) => lose(state, slot, `it reported an error: ${cause.message}`));
}

/** Everything waiting is answered `PARSER_CRASHED`: nothing can serve it (a worker that cannot even start would be started again and again otherwise). */
function rejectQueued(state: PoolState, why: string): void {
  for (const job of state.queue.splice(0)) settle(job, fail("PARSER_CRASHED", GENERIC, { why }));
}

/**
 * The worker is gone or must go (it ended, its channel closed, it did not start in time, it sent nonsense): the job it held is answered
 * `PARSER_CRASHED` and the cause is logged; a worker that was killed on purpose (a timeout) is already `gone` and says nothing.
 */
function lose(state: PoolState, slot: Slot, cause: string): void {
  if (slot.state === "gone") return;
  const wasStarting = slot.state === "starting";
  const active = slot.active;
  slot.active = null;
  retire(state, slot);
  if (active) {
    clearTimeout(active.timer);
    console.error(`[asyncapi-parser] the parser worker (pid ${slot.proc.pid}) was lost while it ran a ${active.job.kind} job: ${cause}`);
    settle(active.job, fail("PARSER_CRASHED", GENERIC));
  } else if (wasStarting) {
    console.error(`[asyncapi-parser] the parser worker (pid ${slot.proc.pid}) did not start: ${cause}`);
    if (state.slots.size === 0) {
      rejectQueued(state, "the worker did not start");
      return;
    }
  }
  pump(state);
}

function onMessage(state: PoolState, slot: Slot, message: FromWorker): void {
  if (slot.state === "gone") return;
  if (typeof message !== "object" || message === null) return lose(state, slot, "it sent a message that is not an object");
  if (message.type === "ready") {
    if (slot.state !== "starting") return lose(state, slot, "it said ready twice");
    slot.state = "idle";
    if (slot.startTimer) clearTimeout(slot.startTimer);
    slot.startTimer = null;
    return pump(state);
  }
  if (message.type !== "result" && message.type !== "failed") return lose(state, slot, "it sent a message of an unknown type");
  const active = slot.active;
  if (!active || active.job.id !== message.id) return lose(state, slot, "it answered a job it was not given");
  let answer: unknown;
  if (message.type === "result") {
    try {
      answer = JSON.parse(message.body);
    } catch {
      return lose(state, slot, "its answer is not JSON");
    }
  }
  clearTimeout(active.timer);
  slot.active = null;
  slot.state = "idle";
  slot.proc.channel?.unref();
  if (message.type === "result") settle(active.job, ok(answer));
  else if (message.reason === "too-large") settle(active.job, fail("PARSER_MESSAGE_TOO_LARGE", "The answer of the parser is too large.", { direction: "from-worker", limitBytes: maxMessageBytes() }));
  else {
    console.error(`[asyncapi-parser] the parser failed on a ${active.job.kind} job:`, message.text);
    settle(active.job, fail("PARSER_JOB_FAILED", GENERIC));
  }
  pump(state);
}

function onTimeout(state: PoolState, slot: Slot): void {
  const active = slot.active;
  if (!active) return;
  slot.active = null;
  retire(state, slot);
  console.warn(`[asyncapi-parser] a ${active.job.kind} job ran longer than ${active.job.timeoutMs} ms: the parser worker (pid ${slot.proc.pid}) was killed`);
  settle(active.job, fail("PARSER_TIMEOUT", "The parser took too long.", { timeoutMs: active.job.timeoutMs }));
  pump(state);
}

function dispatch(state: PoolState, slot: Slot, job: QueuedJob): void {
  if (job.waitTimer) clearTimeout(job.waitTimer);
  job.waitTimer = null;
  slot.state = "busy";
  slot.active = { job, timer: setTimeout(() => onTimeout(state, slot), job.timeoutMs) };
  slot.proc.channel?.ref();
  const message: ToWorker = { type: "job", id: job.id, job: job.wire };
  try {
    slot.proc.send(message, (error) => {
      if (error) lose(state, slot, `the job could not be sent: ${error.message}`);
    });
  } catch (cause) {
    lose(state, slot, `the job could not be sent: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Hands waiting jobs to idle workers, in order, and starts workers (up to the pool size) for those that still wait. */
function pump(state: PoolState): void {
  for (const slot of [...state.slots]) {
    if (state.queue.length === 0) return;
    if (slot.state === "idle") dispatch(state, slot, state.queue.shift() as QueuedJob);
  }
  if (state.queue.length === 0) return;
  let starting = [...state.slots].filter((slot) => slot.state === "starting").length;
  if (starting >= state.queue.length || state.slots.size >= poolSize()) return;
  const located = locateWorker();
  if ("problem" in located) {
    console.error(`[asyncapi-parser] ${located.problem}`);
    return rejectQueuedUnavailable(state);
  }
  while (state.queue.length > starting && state.slots.size < poolSize()) {
    const before = state.slots.size;
    spawnSlot(state, located.file);
    if (state.slots.size === before) return; // the spawn failed and rejected the queue
    starting += 1;
  }
}

function rejectQueuedUnavailable(state: PoolState): void {
  for (const job of state.queue.splice(0)) settle(job, fail("PARSER_UNAVAILABLE", GENERIC));
}

function ensureExitHook(state: PoolState): void {
  if (state.exitHooked) return;
  state.exitHooked = true;
  // `exit` handlers are synchronous: a SIGKILL is, and the workers also exit when this process's channel to them closes.
  process.on("exit", () => {
    for (const slot of state.slots) {
      try {
        slot.proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

// ── The API ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function wireOf(job: ParserJob): Result<WireJob> {
  if (job.kind === "parseSource") {
    if (typeof job.text !== "string") return fail("PARSER_BAD_JOB", "The text of the job is not a string.");
    return ok({ kind: job.kind, text: job.text });
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(job.document);
  } catch (cause) {
    console.error("[asyncapi-parser] a document that cannot be written as JSON was handed to the parser:", cause);
    return fail("PARSER_BAD_JOB", "The document cannot be written as JSON.");
  }
  if (typeof text !== "string") return fail("PARSER_BAD_JOB", "The document cannot be written as JSON.");
  return ok({ kind: job.kind, text });
}

async function runInProcess(wire: WireJob): Promise<Result<unknown>> {
  try {
    const { handleJob } = await import("./parser-core");
    return ok(await handleJob(wire));
  } catch (cause) {
    console.error(`[asyncapi-parser] the parser failed on a ${wire.kind} job (in-process):`, cause);
    return fail("PARSER_JOB_FAILED", GENERIC);
  }
}

/**
 * Runs one job in a worker (see the header). Never throws. `validate`: the parser's diagnostics and our own findings for a document;
 * `importValidate`: the parser's diagnostics for a document read from a file; `parseSource`: `parseAsyncApiSource` of a file's text (the outer
 * `Result` says whether the job ran, the inner one is the function's own answer).
 */
export async function runParserJob<J extends ParserJob>(job: J, options: RunParserJobOptions = {}): Promise<Result<JobResults[J["kind"]]>> {
  const wire = wireOf(job);
  if (!wire.success) return wire;
  const bytes = Buffer.byteLength(wire.data.text, "utf8");
  if (bytes > maxMessageBytes()) return fail("PARSER_MESSAGE_TOO_LARGE", "The document is too large for the parser worker.", { direction: "to-worker", limitBytes: maxMessageBytes(), bytes });
  if (process.env.ASYNCAPI_PARSER_IN_PROCESS === "1") return (await runInProcess(wire.data)) as Result<JobResults[J["kind"]]>;

  const located = locateWorker();
  if ("problem" in located) {
    console.error(`[asyncapi-parser] ${located.problem}`);
    return fail("PARSER_UNAVAILABLE", GENERIC);
  }

  const state = pool();
  ensureExitHook(state);
  const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const result = await new Promise<Result<unknown>>((resolve) => {
    const queued: QueuedJob = { id: state.nextId++, kind: wire.data.kind, wire: wire.data, timeoutMs: timeoutFor(wire.data.kind, options), settled: false, resolve, waitTimer: null };
    state.queue.push(queued);
    pump(state);
    if (queued.settled || !state.queue.includes(queued)) return;
    // still waiting for a worker
    if (state.queue.length > maxQueued) {
      state.queue.splice(state.queue.indexOf(queued), 1);
      return settle(queued, fail("PARSER_BUSY", "The parser is busy.", { reason: "queue-full", maxQueued }));
    }
    queued.waitTimer = setTimeout(() => {
      const at = state.queue.indexOf(queued);
      if (at >= 0) state.queue.splice(at, 1);
      settle(queued, fail("PARSER_BUSY", "The parser is busy.", { reason: "wait-timeout", maxWaitMs }));
    }, maxWaitMs);
  });
  return result as Result<JobResults[J["kind"]]>;
}

// ── What the callers tell a user ───────────────────────────────────────────────────────────────────────────────────────

/** A duration for a sentence: 15000 ms is "15", 1500 ms is "1.5". */
export const secondsText = (ms: number): string => String(Number((ms / 1000).toFixed(1)));
/** The first part of what a user is told when a document is cut at its time limit. */
export const tooComplexLead = (timeoutMs: number): string => `This document is too complex to validate here: the check took longer than ${secondsText(timeoutMs)} seconds and was stopped.`;
export const TOO_COMPLEX_FIX = "Split it into smaller events, or remove the unusually large parts.";
export const BUSY_TEXT = "The validator is busy with other documents. Try again in a moment.";
/** The timeout a `PARSER_TIMEOUT` error carries, in ms (the one actually used). */
export const timeoutOf = (error: { details?: object }): number => {
  const value = (error.details as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  return typeof value === "number" ? value : DEFAULT_TIMEOUT_MS.validate;
};
