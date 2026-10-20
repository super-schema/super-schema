/**
 * A tiny FAKE parser worker (no parser in it), as the source of a CommonJS file the tests write to a temporary directory and name by
 * `ASYNCAPI_PARSER_WORKER`. It speaks the runner's protocol (`parser-job.ts`): `ready` after `FAKE_WORKER_READY_MS`, `accepted` for every job,
 * then does what the job's text (a JSON command) says: `echo`, `env`, `sleep`, `hang` (a synchronous loop), `crash`, and the misbehaviours
 * `garbage`, `wrong-id`, `bad-body`, `throw`, `too-large`. `FAKE_WORKER_MODE`: `crash-on-start`, `die-later` (ends after `FAKE_WORKER_DIE_MS`
 * without ever saying ready), `die-before-ack` (ends when it gets a job, before it says it has it), `never-ready`. `FAKE_WORKER_LOG`: a file every start appends its pid to.
 */
export const FAKE_WORKER = `
const fs = require("node:fs");
const mode = process.env.FAKE_WORKER_MODE || "";
if (process.env.FAKE_WORKER_LOG) fs.appendFileSync(process.env.FAKE_WORKER_LOG, process.pid + "\\n");
process.on("disconnect", () => process.exit(0));
if (mode === "crash-on-start") process.exit(3);
if (mode === "die-later") setTimeout(() => process.exit(4), Number(process.env.FAKE_WORKER_DIE_MS || 100));
const send = (message) => process.send(message);
process.on("message", (message) => {
  if (mode === "die-before-ack") process.exit(5);
  send({ type: "accepted", id: message.id });
  const cmd = JSON.parse(message.job.text);
  const reply = (data) => send({ type: "result", id: message.id, body: JSON.stringify({ success: true, data: data || { pid: process.pid, tag: cmd.tag === undefined ? null : cmd.tag } }) });
  switch (cmd.do) {
    case "echo": return reply();
    case "env": return reply({ pid: process.pid, nodeOptions: process.env.NODE_OPTIONS === undefined ? null : process.env.NODE_OPTIONS, execArgv: process.execArgv });
    case "sleep": return void setTimeout(reply, cmd.ms);
    case "hang": for (;;) { /* a synchronous loop: nothing in this process can stop it */ }
    case "crash": process.exit(1); break;
    case "garbage": return send({ type: "nonsense" });
    case "wrong-id": return send({ type: "result", id: message.id + 1000, body: "{}" });
    case "bad-body": return send({ type: "result", id: message.id, body: "not json" });
    case "throw": return send({ type: "failed", id: message.id, reason: "exception", text: "boom at /srv/secret/path.js:1:1" });
    case "too-large": return send({ type: "failed", id: message.id, reason: "too-large", text: "big" });
  }
});
if (mode !== "never-ready" && mode !== "die-later") setTimeout(() => send({ type: "ready" }), Number(process.env.FAKE_WORKER_READY_MS || 0));
`;

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls `condition` every 20 ms for up to `ms`; true as soon as it holds. */
export async function waitUntil(condition: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}
