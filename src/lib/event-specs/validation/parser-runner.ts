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
//   PARSER_CRASHED      the worker ended, failed to start or sent nonsense while it held the job; or no worker could be started (see "Start
//                       failures"): the cause is in the server log, never in the Result;
//   PARSER_JOB_FAILED   the parser itself threw (the exception is in the server log);
//   PARSER_MESSAGE_TOO_LARGE  the job, or its answer, is over 8 MiB (`details.direction`);
//   PARSER_BAD_JOB      the document cannot be written as JSON (a cycle, a BigInt);
//   PARSER_UNAVAILABLE  the worker file is missing (build it: `npm run build:parser-worker`) or the pool was shut down. FAIL CLOSED: the parser
//                       is never run in the server's process because a file is missing.
//
// Pool: up to `ASYNCAPI_PARSER_WORKERS` workers (default 2; a number is clamped to 1 - 4, so 0 is 1; anything that is not a number is the default),
// spawned lazily and kept warm (the parser is built before a worker says it is ready, about 0.3 s after its start); one job per worker at a time;
// the others wait in a FIFO queue of at most 20 jobs (a job that waits for a worker that is still starting counts) for at most 30 s: beyond either,
// `PARSER_BUSY`. The timeout runs from the moment a job is SENT to a ready worker (defaults: 15 s `validate` and `importValidate`, 4 s
// `parseSource`; `options.timeoutMs`, or `ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS` / `ASYNCAPI_PARSER_PARSE_TIMEOUT_MS`; a value that is not positive is
// ignored, one over 2^31 - 1 ms, which Node timers cannot count, is cut to that). On a timeout the worker gets SIGKILL and a fresh one is started when
// the next job needs it. A worker has `--max-old-space-size=768`; a worker that runs out of memory is a crash like any other. Each way, a message is at
// most 8 MiB (`ASYNCAPI_PARSER_MAX_MESSAGE_BYTES` lowers it, for tests); a worker that is not ready after 20 s is given up on
// (`ASYNCAPI_PARSER_START_TIMEOUT_MS`, for tests). A worker takes `NODE_OPTIONS` from the server minus `--inspect*` and `--max-old-space-size`
// (a second worker could not bind the debugger's port, and the heap limit is passed once, on the command line).
//
// A job handed to a worker that had died (its death not yet noticed) is tried ONCE more on a fresh worker: a worker says `accepted` before it
// works on a job, so a loss without that word means it never saw the job. A worker that dies after it, is a crash.
//
// Start failures: a worker that is lost before it said `ready` (a worker file for a newer Node, a corrupt file, an out-of-memory kill at start in a
// small container) is a failure of the POOL, not of one worker: every job that waits is answered `PARSER_CRASHED` at once, and after 3 such
// failures in a row no worker is started for 5 s (`ASYNCAPI_PARSER_BREAKER_MS`, for tests): jobs get `PARSER_CRASHED` without a start. One line
// is logged when that begins. The first `ready` clears the count. Without this, every dying worker was replaced at once, for ever.
//
// No leaks: a worker exits by itself when its channel to the server closes (a server killed with SIGKILL leaves no orphan, once the worker's
// current job is over: a worker busy in a long synchronous parse when its parent is killed lingers until that job ends, at most the cost of the
// parse), the server kills its workers when it exits, and idle workers and their channel are `unref()`ed, so they never keep the server alive. The
// pool lives on `globalThis`, so Next's hot reload (which evaluates this module again) does not start a second one.
//
// The worker is `worker-dist/asyncapi-parser-worker.cjs`, built from `parser-worker.ts` and everything it imports (`parser-core.ts`,
// `src/lib/events/import/source.ts`, ...) by `npm run build:parser-worker` (it runs before `dev` and `build`; vitest builds it in its global setup).
// Looked for in this order: the file named by `ASYNCAPI_PARSER_WORKER` (when set, only that one), then `<working directory>/worker-dist/
// asyncapi-parser-worker.cjs`. `next build` ships it in the standalone output (`outputFileTracingIncludes`).
//
// A stale worker (NOT in production): the bundle is the code as it was when it was built, so in `next dev` and in vitest's watch mode an edit to
// one of its sources would leave the old code running. The build writes `asyncapi-parser-worker.meta.json` next to the bundle (the repo-relative
// sources it was made from, `node_modules` left out). When `NODE_ENV` is not "production", a job that is about to be handed to a worker (or to start
// one) checks, at most once a second, whether one of those sources is newer than the bundle (or gone); if so it runs the build script
// synchronously (about 0.4 s; once per change: a build that fails is logged and not tried again for 5 s), and every idle or starting worker made
// from the old bundle is replaced by the next start; a busy worker finishes its job first and is replaced when it is idle. In production NOTHING is
// built at run time: the file is what it is, and a missing `.meta.json` just skips the check. A change in `node_modules` needs
// `npm run build:parser-worker`.
//
// What `parseSource` and `validate` give back has been through JSON: a number YAML reads as `.inf`, `.nan`, `-0` or `1e400` comes back as `null` or
// `0`, and a YAML `!!binary` or `!!set` as a plain JSON object, so such a file is not read exactly as in-process. A parsed document whose JSON is
// over 8 MiB (YAML aliases can expand a 1 MiB file that far) is refused (`PARSER_MESSAGE_TOO_LARGE`; the importer says `TOO_LARGE`), and so is a
// parser report of more than about 25,000 diagnostics ("too many problems").
//
// Sizing: every worker may use up to 768 MiB of heap and about 160 - 250 MiB of memory when it is idle, and the pool has 2 workers by default:
// check the limits of the container the server runs in, and lower `ASYNCAPI_PARSER_WORKERS` (down to 1) where memory is tight.
//
// Debugging escape hatch, OFF by default: `ASYNCAPI_PARSER_IN_PROCESS=1` runs the jobs in THIS process, with no timeout and nothing to kill. It is
// for stepping through the parser and for tests that replace the parser (`vi.spyOn(Parser.prototype, ...)`): never set it on a server.
import "server-only";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "@/types/result";
import { maxMessageBytes, type FromWorker, type JobResults, type ParserJobKind, type ToWorker, type WireJob } from "./parser-job";

type ParserJob =
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

const WORKER_FILE_NAME = "asyncapi-parser-worker.cjs";
export const DEFAULT_TIMEOUT_MS: Record<ParserJobKind, number> = { validate: 15_000, importValidate: 15_000, parseSource: 4_000 };
const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUED = 20;
const DEFAULT_MAX_WAIT_MS = 30_000;
/** How long a worker may take to start (load its file, build the parser) before it is given up on. */
const DEFAULT_START_TIMEOUT_MS = 20_000;
/** Start failures in a row after which no worker is started for `DEFAULT_BREAKER_MS`. */
const BREAKER_AFTER = 3;
const DEFAULT_BREAKER_MS = 5_000;
const WORKER_MAX_OLD_SPACE_MB = 768;
/** The longest delay a Node timer can count: a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How often the sources of the worker are looked at for a change, and how long a failed rebuild is left alone. */
const STALE_CHECK_MS = 1_000;
const REBUILD_BACKOFF_MS = 5_000;

const FIX = 'build it with "npm run build:parser-worker"';

const fail = (code: string, message: string, details?: object): Result<never> => err({ code, message, ...(details && { details }) });
const GENERIC = "The AsyncAPI parser worker could not run this job.";

const capTimer = (ms: number): number => Math.min(ms, MAX_TIMER_MS);
/** A positive finite number from the environment, cut to what a timer can count; `undefined` for anything else (unset, empty, zero, negative, text). */
function positiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? capTimer(value) : undefined;
}
function poolSize(): number {
  const raw = process.env.ASYNCAPI_PARSER_WORKERS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_WORKERS;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), MAX_WORKERS) : DEFAULT_WORKERS;
}
function timeoutFor(kind: ParserJobKind, options: RunParserJobOptions): number {
  if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) return capTimer(options.timeoutMs);
  const fromEnv = positiveNumber(kind === "parseSource" ? "ASYNCAPI_PARSER_PARSE_TIMEOUT_MS" : "ASYNCAPI_PARSER_VALIDATE_TIMEOUT_MS");
  return fromEnv ?? DEFAULT_TIMEOUT_MS[kind];
}
/** A duration for a sentence: 15000 ms is "15", 1500 ms is "1.5". */
const secondsText = (ms: number): string => String(Number((ms / 1000).toFixed(1)));

/**
 * The `NODE_OPTIONS` a worker gets: the server's, without the debugger's options (a second process cannot bind the port the first one holds, and
 * would die at start) and without `--max-old-space-size` (the worker's own limit is passed once, on its command line). Exported for its test.
 */
export function childNodeOptions(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const tokens = raw.match(/"[^"]*"|\S+/g) ?? [];
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!/^--(inspect(-brk|-wait|-port|-publish-uid)?|debug-port|max[-_]old[-_]space[-_]size)(=|$)/.test(token)) {
      kept.push(token);
      continue;
    }
    // `--inspect-port 9230` and `--max-old-space-size 4096`: the value is the next token
    const valueFollows = !token.includes("=") && /^--(inspect-port|inspect-publish-uid|debug-port|max[-_]old[-_]space[-_]size)$/.test(token);
    if (valueFollows && tokens[i + 1] !== undefined && !tokens[i + 1].startsWith("-")) i += 1;
  }
  return kept.join(" ");
}
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const options = childNodeOptions(env.NODE_OPTIONS);
  if (options === undefined || options === "") delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = options;
  return env;
}

// ── Pool state (on globalThis) ───────────────────────────────────────────────────────────────────────────────────────────

interface QueuedJob {
  id: number;
  kind: ParserJobKind;
  wire: WireJob;
  timeoutMs: number;
  settled: boolean;
  /** Given to a worker that died before it took it, and tried again once. */
  retried: boolean;
  resolve: (result: Result<unknown>) => void;
  waitTimer: NodeJS.Timeout | null;
}
interface Active { job: QueuedJob; timer: NodeJS.Timeout; accepted: boolean }
interface Slot {
  proc: ChildProcess;
  state: "starting" | "idle" | "busy" | "gone";
  active: Active | null;
  startTimer: NodeJS.Timeout | null;
  /** The modification time of the worker file this process was started from (`null`: not looked at, production). */
  bundleMtime: number | null;
}
interface PoolState {
  slots: Set<Slot>;
  queue: QueuedJob[];
  nextId: number;
  exitHooked: boolean;
  /** Workers lost before `ready` since the last `ready`, and when no worker may be started before. */
  startFailures: number;
  breakerUntil: number;
  /** The last look at the worker file (cached for `STALE_CHECK_MS`), and until when a failed rebuild is not tried again. */
  checked: { file: string; at: number; mtime: number } | null;
  rebuildBackoffUntil: number;
  rebuild: WorkerRebuild | null;
}

const POOL_KEY = Symbol.for("super-schema.asyncapi-parser-pool");
function pool(): PoolState {
  const holder = globalThis as unknown as Record<symbol, PoolState | undefined>;
  const state = (holder[POOL_KEY] ??= { slots: new Set(), queue: [], nextId: 1, exitHooked: false, startFailures: 0, breakerUntil: 0, checked: null, rebuildBackoffUntil: 0, rebuild: null });
  // a pool made by an older version of this module (Next's hot reload keeps it) lacks the newer fields
  state.startFailures ??= 0;
  state.breakerUntil ??= 0;
  state.checked ??= null;
  state.rebuildBackoffUntil ??= 0;
  state.rebuild ??= null;
  return state;
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

/** Stops every worker now. Queued and running jobs are answered `PARSER_UNAVAILABLE`. The next job starts a new worker, with the start failures forgotten. */
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
  state.startFailures = 0;
  state.breakerUntil = 0;
  state.checked = null;
  state.rebuildBackoffUntil = 0;
}

// ── Worker file, and the check that it is not stale ──────────────────────────────────────────────────────────────────────

/** Where the worker file is, or why it is not: the explicit setting is the only candidate when it is set. */
function locateWorker(): { file: string } | { problem: string } {
  const configured = process.env.ASYNCAPI_PARSER_WORKER;
  const file = configured ? path.resolve(configured) : path.join(/* turbopackIgnore: true */ process.cwd(), "worker-dist", WORKER_FILE_NAME);
  if (existsSync(file)) return { file };
  return { problem: `the parser worker file is missing (${file}); ${FIX}${configured ? "" : " (ASYNCAPI_PARSER_WORKER names another place)"}` };
}

/** How the bundle's sources are found and the bundle is made again; replaceable for tests (`setWorkerRebuildForTests`). */
export interface WorkerRebuild {
  /** The sources the bundle was made from, relative to `root`; `null` when that is not known (the check is skipped). */
  inputs(workerFile: string): { root: string; inputs: string[] } | null;
  /** Makes the bundle again, synchronously; throws when it cannot. */
  build(root: string): void;
}
const metaFileOf = (workerFile: string): string => workerFile.replace(/\.cjs$/, ".meta.json");
const defaultRebuild: WorkerRebuild = {
  inputs(workerFile) {
    try {
      const meta = JSON.parse(readFileSync(metaFileOf(workerFile), "utf8")) as { inputs?: unknown };
      if (!Array.isArray(meta.inputs) || !meta.inputs.every((input) => typeof input === "string")) return null;
      return { root: path.resolve(path.dirname(workerFile), ".."), inputs: meta.inputs as string[] };
    } catch {
      return null;
    }
  },
  build(root) {
    // The build script itself (esbuild is not loaded into the server), the same function `npm run build:parser-worker` runs.
    const script = path.join(/* turbopackIgnore: true */ root, "scripts", "build-parser-worker.mjs");
    const run = spawnSync(process.execPath, [script], { cwd: root, env: childEnv(), encoding: "utf8", timeout: 60_000 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`the build script ended with code ${run.status}: ${(run.stderr ?? "").slice(-600)}`);
  },
};
/** Replaces how a stale worker is found and rebuilt (`null`: the real one). For tests. */
export function setWorkerRebuildForTests(rebuild: WorkerRebuild | null): void {
  pool().rebuild = rebuild;
}

/** The first source that is newer than the bundle, or is gone; `null` when the bundle is up to date. */
function changedSource(known: { root: string; inputs: string[] }, bundleMtime: number): string | null {
  for (const input of known.inputs) {
    try {
      if (statSync(path.join(known.root, input)).mtimeMs > bundleMtime) return input;
    } catch {
      return input;
    }
  }
  return null;
}

/**
 * The modification time of the worker file, after making it again if a source of it is newer. `null` in production (nothing is looked at, nothing
 * is built there) and when the file cannot be read. Looks at the disk at most once per `STALE_CHECK_MS`.
 */
function currentBundleMtime(state: PoolState, file: string): number | null {
  if (process.env.NODE_ENV === "production") return null;
  const now = Date.now();
  if (state.checked && state.checked.file === file && now - state.checked.at < STALE_CHECK_MS) return state.checked.mtime;
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const rebuild = state.rebuild ?? defaultRebuild;
  const known = rebuild.inputs(file);
  const changed = known === null || now < state.rebuildBackoffUntil ? null : changedSource(known, mtime);
  if (known !== null && changed !== null) {
    try {
      rebuild.build(known.root);
      mtime = statSync(file).mtimeMs;
      console.warn(`[asyncapi-parser] ${changed} changed since the parser worker was built: it was built again, and the workers made from the old file are replaced`);
    } catch (cause) {
      state.rebuildBackoffUntil = Date.now() + REBUILD_BACKOFF_MS;
      console.error(`[asyncapi-parser] ${changed} changed since the parser worker was built, and building it again failed (the old worker stays; ${FIX}):`, cause);
    }
  }
  state.checked = { file, at: Date.now(), mtime };
  return mtime;
}

/** Replaces the workers made from an older file than `mtime` that hold no job (a busy one is replaced when it is idle). */
function retireStale(state: PoolState, mtime: number): void {
  for (const slot of [...state.slots]) {
    if ((slot.state === "idle" || slot.state === "starting") && slot.bundleMtime !== mtime) retire(state, slot);
  }
}

// ── Starting, feeding and losing workers ──────────────────────────────────────────────────────────────────────────────────

function spawnSlot(state: PoolState, file: string, bundleMtime: number | null): void {
  let proc: ChildProcess;
  try {
    proc = fork(file, [], {
      execArgv: [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`],
      env: childEnv(),
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
  } catch (cause) {
    console.error("[asyncapi-parser] the parser worker could not be started:", cause);
    noteStartFailure(state);
    rejectQueued(state, "could not start");
    return;
  }
  const slot: Slot = { proc, state: "starting", active: null, startTimer: null, bundleMtime };
  state.slots.add(slot);
  proc.unref();
  proc.channel?.unref();
  const startTimeout = positiveNumber("ASYNCAPI_PARSER_START_TIMEOUT_MS") ?? DEFAULT_START_TIMEOUT_MS;
  slot.startTimer = setTimeout(() => lose(state, slot, `it did not become ready within ${startTimeout} ms`), startTimeout);
  proc.on("message", (message) => onMessage(state, slot, message as FromWorker));
  proc.on("exit", (code, signal) => lose(state, slot, `it ended (code ${code}, signal ${signal})`));
  // A crashed worker closes its channel just before its `exit` event, which has the code and the signal: give it a moment, for the log.
  proc.on("disconnect", () => void setTimeout(() => lose(state, slot, "its channel closed"), 100).unref());
  proc.on("error", (cause) => lose(state, slot, `it reported an error: ${cause.message}`));
}

const breakerIsOpen = (state: PoolState): boolean => Date.now() < state.breakerUntil;

/** Counts a worker lost before `ready`; after `BREAKER_AFTER` in a row no worker is started for a while (one log line when that begins). */
function noteStartFailure(state: PoolState): void {
  state.startFailures += 1;
  if (state.startFailures < BREAKER_AFTER || breakerIsOpen(state)) return;
  const delay = positiveNumber("ASYNCAPI_PARSER_BREAKER_MS") ?? DEFAULT_BREAKER_MS;
  state.breakerUntil = Date.now() + delay;
  console.error(`[asyncapi-parser] ${state.startFailures} parser workers in a row did not start: no worker is started for ${secondsText(delay)} s, and jobs are refused meanwhile (see the lines above for why)`);
}

/** Everything waiting is answered `PARSER_CRASHED`: nothing can serve it (workers that cannot even start would be started again and again otherwise). */
function rejectQueued(state: PoolState, why: string): void {
  for (const job of state.queue.splice(0)) settle(job, fail("PARSER_CRASHED", GENERIC, { why }));
}

/**
 * The worker is gone or must go (it ended, its channel closed, it did not start in time, it sent nonsense). A worker that was killed on purpose
 * (a timeout) is already `gone` and says nothing. Otherwise:
 * - it was starting: a failure of the pool, every job that waits is answered `PARSER_CRASHED` (see the header);
 * - it held a job it had not said it took: the job is tried once more, on another worker;
 * - it held a job it had taken: the job is answered `PARSER_CRASHED` and the cause is logged.
 */
function lose(state: PoolState, slot: Slot, cause: string): void {
  if (slot.state === "gone") return;
  const wasStarting = slot.state === "starting";
  const active = slot.active;
  slot.active = null;
  retire(state, slot);
  if (active) {
    clearTimeout(active.timer);
    if (!active.accepted && !active.job.retried) {
      active.job.retried = true;
      console.warn(`[asyncapi-parser] the parser worker (pid ${slot.proc.pid}) was lost before it took a ${active.job.kind} job (${cause}): the job goes to another worker`);
      state.queue.unshift(active.job);
    } else {
      console.error(`[asyncapi-parser] the parser worker (pid ${slot.proc.pid}) was lost while it ran a ${active.job.kind} job: ${cause}`);
      settle(active.job, fail("PARSER_CRASHED", GENERIC));
    }
  } else if (wasStarting) {
    console.error(`[asyncapi-parser] the parser worker (pid ${slot.proc.pid}) did not start: ${cause}`);
    noteStartFailure(state);
    rejectQueued(state, "the worker did not start");
    return;
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
    state.startFailures = 0;
    state.breakerUntil = 0;
    return pump(state);
  }
  if (message.type === "accepted") {
    if (!slot.active || slot.active.job.id !== message.id) return lose(state, slot, "it took a job it was not given");
    slot.active.accepted = true;
    return;
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
  slot.active = { job, timer: setTimeout(() => onTimeout(state, slot), job.timeoutMs), accepted: false };
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
  if (state.queue.length === 0) return;
  const located = locateWorker();
  const mtime = "file" in located ? currentBundleMtime(state, located.file) : null;
  if (mtime !== null) retireStale(state, mtime);
  for (const slot of [...state.slots]) {
    if (state.queue.length === 0) return;
    if (slot.state === "idle") dispatch(state, slot, state.queue.shift() as QueuedJob);
  }
  if (state.queue.length === 0) return;
  let starting = [...state.slots].filter((slot) => slot.state === "starting").length;
  if (starting >= state.queue.length || state.slots.size >= poolSize()) return;
  if ("problem" in located) {
    console.error(`[asyncapi-parser] ${located.problem}`);
    return rejectQueuedUnavailable(state);
  }
  if (breakerIsOpen(state)) {
    // no worker is started now; with none alive either, nothing can serve what waits (a live worker may still)
    if (state.slots.size === 0) rejectQueued(state, "workers did not start (a pause before the next try)");
    return;
  }
  while (state.queue.length > starting && state.slots.size < poolSize()) {
    const before = state.slots.size;
    spawnSlot(state, located.file, mtime);
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
  const maxWaitMs = options.maxWaitMs !== undefined && Number.isFinite(options.maxWaitMs) && options.maxWaitMs > 0 ? capTimer(options.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
  const result = await new Promise<Result<unknown>>((resolve) => {
    const queued: QueuedJob = { id: state.nextId++, kind: wire.data.kind, wire: wire.data, timeoutMs: timeoutFor(wire.data.kind, options), settled: false, retried: false, resolve, waitTimer: null };
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

/** The first part of what a user is told when a document is cut at its time limit. */
export const tooComplexLead = (timeoutMs: number): string => `This document is too complex to validate here: the check took longer than ${secondsText(timeoutMs)} seconds and was stopped.`;
export const TOO_COMPLEX_FIX = "Split it into smaller events, or remove the unusually large parts.";
export const BUSY_TEXT = "The validator is busy with other documents. Try again in a moment.";
/** The timeout a `PARSER_TIMEOUT` error carries, in ms (the one actually used). */
export const timeoutOf = (error: { details?: object }): number => {
  const value = (error.details as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  return typeof value === "number" ? value : DEFAULT_TIMEOUT_MS.validate;
};
