// src/lib/event-specs/validation/parser-worker.ts
// The entry point of a parser worker: a child process that answers the jobs of `parser-runner.ts` (read its header). It is bundled by
// `scripts/build-parser-worker.mjs` into ONE self-contained CommonJS file, `worker-dist/asyncapi-parser-worker.cjs` (nothing is `require`d from
// `node_modules` at run time, so it runs from any directory, standalone output included). Not a module anything else imports.
//
// One job at a time (the parent sends the next one when the answer arrived). The worker is killed by the parent when a job takes too long, so
// it keeps no state that matters; it exits by itself when the channel to its parent closes (a parent that was killed leaves no orphan).
import { handleJob, warmUp } from "./parser-core";
import { maxMessageBytes, type FromWorker, type ToWorker } from "./parser-job";

/** A message to the parent; a parent that is gone is not an error here (the `disconnect` handler ends the process). */
const send = (message: FromWorker): void => {
  try {
    if (process.connected) process.send?.(message);
  } catch {
    // the channel closed between the check and the send
  }
};

if (typeof process.send !== "function") {
  console.error("[asyncapi-parser-worker] this file is started by the server with an IPC channel (child_process.fork), not on its own");
  process.exit(2);
}

process.on("disconnect", () => process.exit(0));

process.on("message", async (message: ToWorker) => {
  if (!message || message.type !== "job") return;
  const { id, job } = message;
  try {
    const body = JSON.stringify(await handleJob(job));
    const limit = maxMessageBytes();
    if (Buffer.byteLength(body, "utf8") > limit) send({ type: "failed", id, reason: "too-large", text: `the answer to a ${job.kind} job is over ${limit} bytes` });
    else send({ type: "result", id, body });
  } catch (cause) {
    send({ type: "failed", id, reason: "exception", text: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause) });
  }
});

// Build the parser first, then say so: the parent starts the clock of a job when it is sent, not while the worker is still starting.
warmUp();
send({ type: "ready", pid: process.pid });
