// @vitest-environment node
/**
 * `runAfterResponse`: inside a request the task is handed to `after` (it runs once the response is sent and is not run before it); outside one,
 * where `after` throws, it starts in the background at once. Either way a failure is logged under the label and never thrown into the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: h.after }));

import { runAfterResponse } from "@/lib/after-response";

/** The callback `after` was handed, as the request will run it. */
const registered = (): (() => Promise<void>) => h.after.mock.calls[0][0] as () => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAfterResponse", () => {
  it("inside a request, hands the task to `after` and does not run it before the response", async () => {
    h.after.mockImplementation(() => undefined);
    const task = vi.fn(async () => undefined);

    runAfterResponse("Emission notification", task);

    expect(h.after).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
    await registered()();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("outside a request (`after` throws), starts the task in the background at once", async () => {
    h.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const task = vi.fn(async () => undefined);

    runAfterResponse("Emission notification", task);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("logs a failed task under its label and throws nothing, inside a request", async () => {
    h.after.mockImplementation(() => undefined);

    expect(() => runAfterResponse("Governance decision notification", async () => Promise.reject(new Error("boom")))).not.toThrow();

    await expect(registered()()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("Governance decision notification failed:", expect.any(Error));
  });

  it("logs a failed task under its label and throws nothing, outside a request", async () => {
    h.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });

    expect(() => runAfterResponse("Emission notification", async () => Promise.reject(new Error("boom")))).not.toThrow();

    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("Emission notification failed:", expect.any(Error)));
  });
});
