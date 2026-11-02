import { after } from "next/server";

/**
 * Runs `task` once the response has been sent, so that work which follows a write (a notification, a webhook delivery) neither delays the
 * answer nor fails the write. Inside a request (a route handler, a server action) that is `after` from `next/server`, which keeps the task for
 * once the response is sent. Outside a request scope (a script, a unit test), `after` throws and the task starts in the background at once.
 * Either way it never throws into the caller: a failure is logged with `label`.
 */
export function runAfterResponse(label: string, task: () => Promise<unknown>): void {
  const settled = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      console.error(`${label} failed:`, error);
    }
  };
  try {
    after(settled);
  } catch {
    // `after` throws synchronously outside a request scope: nothing is registered, so the task runs now, detached.
    void settled();
  }
}
