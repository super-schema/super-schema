import { describe, expect, it } from "vitest";
import { admitCompilerRuns, RUNS_PER_PRINCIPAL } from "@/lib/emission/emission-admission";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";

/**
 * One principal's compiler runs in flight are capped (src/lib/emission/emission-admission.ts): a call over its share is refused at once, so it
 * cannot fill the compiler's queue for everybody else. The module keeps its state for the life of the process, so each test uses its own principals.
 */
describe("the per-principal share of the compiler", () => {
  it("admits a principal's runs up to RUNS_PER_PRINCIPAL and refuses the call that would go over it", () => {
    const principal = "share-user-1";
    expect(admitCompilerRuns(principal, 8)).not.toBeNull();
    expect(admitCompilerRuns(principal, 8)).not.toBeNull();
    expect(RUNS_PER_PRINCIPAL).toBe(16);
    expect(admitCompilerRuns(principal, 1)).toBeNull();
  });

  it("gives the share back when the emission settles, so the next call is admitted", () => {
    const principal = "share-user-2";
    const hold = admitCompilerRuns(principal, RUNS_PER_PRINCIPAL)!;
    expect(admitCompilerRuns(principal, 1)).toBeNull();
    hold();
    expect(admitCompilerRuns(principal, 1)).not.toBeNull();
  });

  it("does not let one principal's runs refuse another principal: the other one is admitted while the first is at its share", () => {
    const flooding = "share-user-3";
    const other = "share-user-4";
    expect(admitCompilerRuns(flooding, RUNS_PER_PRINCIPAL)).not.toBeNull();
    expect(admitCompilerRuns(flooding, 8)).toBeNull();
    expect(admitCompilerRuns(other, 8)).not.toBeNull();
  });

  it("counts a call with no runs as one run, so it always takes part in the share", () => {
    const principal = "share-user-5";
    expect(admitCompilerRuns(principal, 0)).not.toBeNull();
    for (let i = 1; i < RUNS_PER_PRINCIPAL; i += 1) expect(admitCompilerRuns(principal, 1)).not.toBeNull();
    expect(admitCompilerRuns(principal, 1)).toBeNull();
  });

  it("has room for one emission of every enabled target: a larger catalog would refuse every emit at once, so the suite fails first", () => {
    const enabled = getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab).length;
    expect(enabled).toBeLessThanOrEqual(RUNS_PER_PRINCIPAL);
    expect(admitCompilerRuns("share-user-6", enabled)).not.toBeNull();
  });
});
