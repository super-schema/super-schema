import { buildParserWorker } from "../scripts/build-parser-worker.mjs";

/**
 * Builds the parser worker (`worker-dist/asyncapi-parser-worker.cjs`) once, before any test file runs: every test that validates an AsyncAPI
 * document or imports a file goes through `parser-runner.ts`, which starts that file as a child process. Nobody has to remember
 * `npm run build:parser-worker` before `vitest`; it is the same build (`scripts/build-parser-worker.mjs`, about half a second).
 */
export default async function setup(): Promise<void> {
  await buildParserWorker();
}
