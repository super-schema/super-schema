import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * No process outlives its parent, and the pool never keeps its parent alive: a throwaway Node program (the runner bundled by esbuild, started
 * with `node`) runs one job on the REAL worker, then it is killed with SIGKILL (no `exit` handler runs), or it just ends.
 */

const ROOT = process.cwd();
const REAL_WORKER = path.join(ROOT, "worker-dist", "asyncapi-parser-worker.cjs");

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "parser-orphans-"));
  await build({
    entryPoints: [path.join(ROOT, "src/lib/event-specs/validation/parser-runner.ts")],
    outfile: path.join(dir, "runner.cjs"),
    absWorkingDir: ROOT,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: { "server-only": path.join(ROOT, "scripts/stubs/server-only.cjs") },
    external: ["./parser-core"], // only the in-process switch loads it
    logLevel: "silent",
  });
  writeFileSync(path.join(dir, "parent.cjs"), `
const { runParserJob, parserPoolStatus } = require("./runner.cjs");
(async () => {
  const result = await runParserJob({ kind: "parseSource", text: "asyncapi: 3.0.0\\ninfo:\\n  title: t\\n  version: '1'\\n" });
  console.log(JSON.stringify({ ok: result.success, pids: parserPoolStatus().workers.map((w) => w.pid) }));
  if (process.env.PARENT_MODE === "hold") setInterval(() => {}, 1000); // stay until killed
})();
`);
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function startParent(mode: "hold" | "natural", extraEnv: Record<string, string> = {}): { proc: ChildProcess; firstLine: Promise<{ ok: boolean; pids: number[] }>; exited: Promise<{ code: number | null; signal: string | null }> } {
  const proc = spawn(process.execPath, [path.join(dir, "parent.cjs")], {
    env: { ...process.env, ASYNCAPI_PARSER_WORKER: REAL_WORKER, PARENT_MODE: mode, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const firstLine = new Promise<{ ok: boolean; pids: number[] }>((resolve, reject) => {
    let buffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.split("\n")[0];
      if (buffer.includes("\n")) resolve(JSON.parse(line));
    });
    proc.on("exit", () => reject(new Error(`the parent ended before it answered: ${buffer}`)));
  });
  firstLine.catch(() => undefined);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  return { proc, firstLine, exited };
}

async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
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

describe("no orphan, no process kept alive", () => {
  it("a parent killed with SIGKILL leaves no worker: the worker exits when its channel closes (within 2 s)", async () => {
    const { proc, firstLine, exited } = startParent("hold");
    const { ok, pids } = await firstLine;
    expect(ok).toBe(true);
    expect(pids).toHaveLength(1);
    expect(() => process.kill(pids[0], 0)).not.toThrow(); // the worker is running

    proc.kill("SIGKILL");
    await exited;

    expect(await waitUntilGone(pids[0], 2_000)).toBe(true);
  }, 30_000);

  it("a worker that something keeps alive still exits within 2 s of its parent's SIGKILL: its own disconnect handler ends it", async () => {
    // Without that handler a worker with nothing else to do would exit when the channel closes, and this test could not tell; here an interval
    // (preloaded into every process through NODE_OPTIONS, which the worker inherits) keeps its event loop running, so only the handler can end it.
    writeFileSync(path.join(dir, "keepalive.cjs"), "setInterval(() => {}, 1000);\n");
    const { proc, firstLine, exited } = startParent("hold", { NODE_OPTIONS: `--require=${path.join(dir, "keepalive.cjs")}` });
    const { ok, pids } = await firstLine;
    expect(ok).toBe(true);
    expect(pids).toHaveLength(1);

    proc.kill("SIGKILL");
    await exited;

    expect(await waitUntilGone(pids[0], 2_000)).toBe(true);
  }, 30_000);

  it("a parent that has nothing else to do ends by itself (an idle worker never keeps it alive), and takes its worker with it", async () => {
    const { firstLine, exited } = startParent("natural");
    const { pids } = await firstLine;
    const end = await Promise.race([exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 8_000))]);
    expect(end).toEqual({ code: 0, signal: null });
    expect(await waitUntilGone(pids[0], 2_000)).toBe(true);
  }, 30_000);
});
