import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
vi.mock("@/lib/db", () => ({ prisma: {} }));
import { runTypeSpecEmitterFiles } from "@/lib/typespec-official/emitter.service";

afterEach(() => vi.restoreAllMocks());

describe("runTypeSpecEmitterFiles — timeout and workspace failures", () => {
  it("kills a tsp that outlives timeoutMs and reports EMITTER_TIMEOUT (does not throw)", async () => {
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", 'import "@typespec/json-schema";\nmodel A { id: string; }\n', {}, { timeoutMs: 1 });
    expect(!r.success && r.error.code).toBe("EMITTER_TIMEOUT");
    expect(!r.success && r.error.message).toContain("1 ms");
  }, 60_000);

  it("returns EMITTER_FAILED instead of throwing when the temp workspace cannot be created", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("EACCES: no space"));
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", "model A {}", {});
    expect(!r.success && r.error.code).toBe("EMITTER_FAILED");
    expect(!r.success && r.error.message).toContain("EACCES");
  });

  it("does not let a failing cleanup replace the result", async () => {
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementationOnce(async (target, options) => {
      await realRm(target, options); // really remove the workspace, then fail like a flaky filesystem would
      throw new Error("EBUSY");
    });
    const r = await runTypeSpecEmitterFiles("@typespec/json-schema", "model A {}", {}, { timeoutMs: 1 });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(!r.success && r.error.code).toBe("EMITTER_TIMEOUT");
  }, 60_000);
});
