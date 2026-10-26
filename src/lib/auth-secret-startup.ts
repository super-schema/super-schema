/**
 * What a production server does with a missing or weak session secret: write the reason and END THE PROCESS (exit code 1). Throwing from Next's
 * instrumentation hook is not enough: `next start` then stays up and answers 500 to every request (seen with a real build), so the process is alive
 * for an orchestrator that restarts on exit, and a health check that only opens the port passes. Nothing happens in development and test, or for a
 * strong secret. The exit waits for the message to be written (an exit right after an asynchronous write can lose it).
 *
 * Node only (src/instrumentation.ts): it lives apart from src/lib/auth-secret.ts because the middleware imports that module and runs in the Edge
 * runtime, where `process.exit` and `process.stderr` do not exist (Next reports each use of them while the middleware is compiled).
 */
import { assertProductionAuthSecret } from "@/lib/auth-secret";

type Env = Record<string, string | undefined>;

export function refuseToStartWithoutProductionSecret(
  env: Env = process.env,
  deps: { write?: (text: string, done: () => void) => void; exit?: (code: number) => void } = {},
): void {
  const write = deps.write ?? ((text, done) => void process.stderr.write(text, done));
  const exit = deps.exit ?? ((code) => process.exit(code));
  try {
    assertProductionAuthSecret(env);
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`, () => exit(1));
  }
}
