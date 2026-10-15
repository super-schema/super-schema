import { err, ok, type Result } from "@/types/result";

/**
 * Bounds for the schema-import server actions, which run a parser / the TypeSpec compiler on caller-supplied text.
 * Lives outside the "use server" action modules (those may only export async functions).
 */

/** Largest import payload accepted (UTF-8 bytes): ample for a real schema, far below what a compile would choke on. */
export const MAX_IMPORT_CONTENT_BYTES = 1024 * 1024;

/** How long an import may wait on the in-process compiler before the action gives up. */
export const IMPORT_COMPILE_TIMEOUT_MS = 30_000;

/** `VALIDATION_ERROR` when `content` is larger than `MAX_IMPORT_CONTENT_BYTES`. */
export function checkImportSize(content: string, what: string): Result<void> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_IMPORT_CONTENT_BYTES) return ok(undefined);
  return err({
    code: "VALIDATION_ERROR",
    message: `The ${what} is too large to import (${(bytes / 1024 / 1024).toFixed(1)} MB); the limit is ${MAX_IMPORT_CONTENT_BYTES / 1024 / 1024} MB`,
    suggestedFix: `Import a smaller ${what}, or split it into several files.`,
  });
}

/**
 * Resolves with `task()`'s result, or `COMPILE_TIMEOUT` once `timeoutMs` has passed.
 *
 * LIMITATION: the TypeSpec compiler runs in this process and cannot be cancelled, so after a timeout the compile
 * keeps running in the background until it finishes by itself; the action merely stops waiting for it (its late
 * result or rejection is discarded). The timeout bounds the request, not the CPU; the size cap bounds the work.
 * A rejection of `task` before the timeout is rethrown unchanged.
 */
export async function withCompileTimeout<T>(task: () => Promise<T>, timeoutMs: number = IMPORT_COMPILE_TIMEOUT_MS): Promise<Result<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          err({
            code: "COMPILE_TIMEOUT",
            message: `Compiling the document took longer than ${Math.round(timeoutMs / 1000)} seconds and was abandoned`,
            suggestedFix: "Import a smaller or simpler document.",
          })
        ),
      timeoutMs
    );
    timer.unref?.();
  });
  const running = task();
  running.catch(() => undefined); // a rejection that arrives after the timeout won must not become an unhandled rejection
  try {
    return await Promise.race([running.then((data): Result<T> => ok(data)), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
