// scripts/verify-parser-worker.mjs
// Proves that the AsyncAPI parser worker runs from the STANDALONE output, where there is no `node_modules` above it:
//
//   npx next build --webpack            (or `npm run build`; either leaves `.next/standalone`)
//   node scripts/verify-parser-worker.mjs [path-to-standalone-dir]
//
// 1. copies `.next/standalone` (and the root `worker-dist/` when the build did not ship it inside) to a new directory under the system temp
//    directory, and checks that no `node_modules` exists above that copy;
// 2. starts `worker-dist/asyncapi-parser-worker.cjs` from that copy with plain `node` (child_process.fork, as the server does) and sends it a
//    `validate`, an `importValidate` and two `parseSource` jobs over IPC; prints the answers;
// 3. starts the worker file ALONE in an empty directory (no `node_modules`, no standalone around it): the file needs nothing else;
// 4. bundles the runner (`parser-runner.ts`), runs it from the copy as its working directory with NO `ASYNCAPI_PARSER_WORKER`, and runs a job
//    through it: the lookup the server does (`<cwd>/worker-dist/...`) finds the file the build shipped.
// Exit code 0 when every check passes.
import { fork, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.resolve(process.argv[2] ?? path.join(root, ".next", "standalone"));
const WORKER = path.join("worker-dist", "asyncapi-parser-worker.cjs");

let failed = 0;
const check = (label, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) failed += 1;
};
const show = (label, value) => console.log(`      ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

const streetlights = `
asyncapi: 3.0.0
info: { title: Streetlights, version: 1.0.0 }
channels:
  lightMeasured:
    address: smartylighting.streetlights.1.0.event.measured
    messages:
      measured:
        payload: { type: object, properties: { lumens: { type: integer } } }
operations:
  receiveLightMeasurement:
    action: receive
    channel: { $ref: '#/channels/lightMeasured' }
    messages: [ { $ref: '#/channels/lightMeasured/messages/measured' } ]
`;
const documentOf = { asyncapi: "3.0.0", info: { title: "Streetlights", version: "1.0.0" }, channels: { c: { address: "c", messages: { m: { payload: { type: "object" } } } } } };

/** Runs jobs on the worker file with `node`, one at a time; resolves with the answers in order. */
function talkToWorker(file, cwd, jobs) {
  return new Promise((resolve, reject) => {
    const child = fork(file, [], { cwd, serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, NODE_PATH: "" } });
    const answers = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("the worker did not answer in 30 s")); }, 30_000);
    child.on("error", reject);
    child.on("exit", (code) => { if (answers.length < jobs.length) { clearTimeout(timer); reject(new Error(`the worker ended (code ${code}) before it answered every job`)); } });
    child.on("message", (message) => {
      if (message.type === "ready") return child.send({ type: "job", id: 0, job: jobs[0] });
      answers.push(message);
      if (answers.length === jobs.length) {
        clearTimeout(timer);
        child.disconnect();
        return resolve(answers);
      }
      child.send({ type: "job", id: answers.length, job: jobs[answers.length] });
    });
  });
}

const jobs = [
  { kind: "validate", text: JSON.stringify(documentOf) },
  { kind: "importValidate", text: JSON.stringify(documentOf) },
  { kind: "parseSource", text: streetlights },
  { kind: "parseSource", text: "asyncapi: 2.6.0\ninfo: { title: t, version: '1' }\n" },
];
function checkAnswers(where, answers) {
  const body = (i) => (answers[i].type === "result" ? JSON.parse(answers[i].body) : null);
  check(`${where}: validate job answered`, answers[0].type === "result", answers[0].type === "result" ? "" : answers[0].text);
  const validated = body(0);
  show("validate", { parser: validated?.parser?.map((d) => `${d.code} (severity ${d.severity})`), extra: validated?.extra });
  check(`${where}: validate has the parser's diagnostics and no error`, Array.isArray(validated?.parser) && validated.parser.every((d) => d.severity !== 0));
  const imported = body(1);
  show("importValidate", { diagnostics: imported?.diagnostics?.map((d) => `${d.code} (severity ${d.severity})`) });
  check(`${where}: importValidate answered with diagnostics`, Array.isArray(imported?.diagnostics));
  const parsed = body(2);
  show("parseSource (AsyncAPI 3 YAML)", parsed?.success ? { success: true, asyncapi: parsed.data.asyncapi, channels: Object.keys(parsed.data.channels) } : parsed);
  check(`${where}: parseSource reads a YAML document`, parsed?.success === true && parsed.data.asyncapi === "3.0.0");
  const refused = body(3);
  show("parseSource (AsyncAPI 2.6)", refused?.success === false ? { success: false, code: refused.error.code, message: refused.error.message } : refused);
  check(`${where}: parseSource refuses AsyncAPI 2.x with its own error code`, refused?.success === false && refused.error.code === "UNSUPPORTED_VERSION");
}

// /tmp (not the user's TMPDIR, which may hold a stray node_modules): the copy must have no node_modules anywhere above it
const base = process.env.PARSER_VERIFY_DIR ?? (existsSync("/tmp") ? "/tmp" : tmpdir());
const temporary = mkdtempSync(path.join(base, "parser-worker-standalone-"));
try {
  check("a standalone build exists", existsSync(path.join(standalone, "server.js")), standalone);
  if (!existsSync(path.join(standalone, "server.js"))) throw new Error("run `npx next build --webpack` first");

  // 1. the copy, WITHOUT the standalone's own node_modules (the worker must need no package at all; in a worktree that folder is a symlink to
  // the shared one, which would hide a missing package)
  const copy = path.join(temporary, "app");
  show("the standalone output has a node_modules of its own (not copied)", existsSync(path.join(standalone, "node_modules")));
  cpSync(standalone, copy, { recursive: true, verbatimSymlinks: true, filter: (source) => path.basename(source) !== "node_modules" });
  if (!existsSync(path.join(copy, WORKER))) {
    check("the build shipped the worker inside .next/standalone", false, "copying it from the project's worker-dist");
    mkdirSync(path.join(copy, "worker-dist"), { recursive: true });
    cpSync(path.join(root, WORKER), path.join(copy, WORKER));
  } else {
    check("the build shipped worker-dist/asyncapi-parser-worker.cjs inside .next/standalone (outputFileTracingIncludes)", true);
  }
  let aboveHasModules = null;
  for (let dir = path.dirname(copy); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules"))) aboveHasModules ??= dir;
    if (dir === path.dirname(dir)) break;
  }
  check("no node_modules above or inside the copy", aboveHasModules === null && !existsSync(path.join(copy, "node_modules")), aboveHasModules ? `found in ${aboveHasModules}` : copy);
  const worker = path.join(copy, WORKER);
  show("worker file size", `${(readFileSync(worker).length / 1024 / 1024).toFixed(1)} MiB`);

  // 2. from the standalone copy
  console.log("\n-- the worker from the standalone copy --");
  checkAnswers("standalone copy", await talkToWorker(worker, copy, jobs));

  // 3. the file alone
  console.log("\n-- the worker file alone in an empty directory --");
  const alone = path.join(temporary, "alone");
  mkdirSync(alone);
  cpSync(path.join(copy, WORKER), path.join(alone, "worker.cjs"));
  checkAnswers("alone", await talkToWorker(path.join(alone, "worker.cjs"), alone, jobs));

  // 4. the runner's own lookup, from the copy as the working directory
  console.log("\n-- the runner, working directory = the standalone copy, no ASYNCAPI_PARSER_WORKER --");
  const runner = path.join(temporary, "runner.cjs");
  await build({
    entryPoints: [path.join(root, "src/lib/event-specs/validation/parser-runner.ts")],
    outfile: runner, absWorkingDir: root, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    alias: { "server-only": path.join(root, "scripts/stubs/server-only.cjs") },
    external: ["./parser-core"],
  });
  writeFileSync(path.join(temporary, "parent.cjs"), `
const { runParserJob, parserPoolStatus } = require(${JSON.stringify(runner)});
(async () => {
  const parsed = await runParserJob({ kind: "parseSource", text: ${JSON.stringify(streetlights)} });
  const validated = await runParserJob({ kind: "validate", document: ${JSON.stringify(documentOf)} });
  console.log(JSON.stringify({ parsed: parsed.success && parsed.data.success, validated: validated.success && validated.data.parser.length, workers: parserPoolStatus().workers.length }));
})();
`);
  const out = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ASYNCAPI_PARSER_WORKER;
    const proc = spawn(process.execPath, [path.join(temporary, "parent.cjs")], { cwd: copy, env, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    proc.stdout.on("data", (chunk) => (text += chunk));
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve(text.trim()) : reject(new Error(`the parent ended with code ${code}: ${text}`))));
  });
  show("runner answer", out);
  const answer = JSON.parse(out);
  check("the runner found worker-dist/ in its working directory and ran a parseSource and a validate job", answer.parsed === true && typeof answer.validated === "number" && answer.workers === 1);
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
