/**
 * src/instrumentation.ts is the one place that can refuse to start: it runs the session-secret check and the sign-in provider check, in the Node
 * runtime of a server (not in the Edge runtime, not while `next build` collects pages, where there are no settings at all).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ secret: vi.fn(), providers: vi.fn() }));
vi.mock("@/lib/auth-secret-startup", () => ({ refuseToStartWithoutProductionSecret: mocks.secret }));
vi.mock("@/lib/auth/providers", () => ({ refuseToStartWithBadProviderConfiguration: mocks.providers }));

import { register } from "@/instrumentation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("instrumentation register()", () => {
  it("runs the secret check and the sign-in provider check when a Node server starts", async () => {
    await register();
    expect(mocks.secret).toHaveBeenCalledTimes(1);
    expect(mocks.providers).toHaveBeenCalledTimes(1);
  });

  it("runs neither in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.providers).not.toHaveBeenCalled();
  });

  it("runs neither while `next build` collects pages (no settings exist at build time)", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    expect(mocks.secret).not.toHaveBeenCalled();
    expect(mocks.providers).not.toHaveBeenCalled();
  });
});
