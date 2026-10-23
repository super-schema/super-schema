/**
 * Always-on corpus smoke: a few representative cases x every enabled target, compile + offline validators only (no emulators, no
 * round trip), so a regression in the generation chain shows up in the normal suite. The full corpus is corpus.test.ts (CORPUS=1).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { CORPUS, SMOKE_CASE_IDS } from "../../fixtures/corpus/manifest";
import { runCases, problemsOf, enabledTargets, allowedSkipTiersFromEnv, type CaseResult } from "../../helpers/corpus/orchestrate";

vi.mock("server-only", () => ({}));

const cases = SMOKE_CASE_IDS.map((id) => {
  const c = CORPUS.find((x) => x.id === id);
  if (!c) throw new Error(`smoke case ${id} is not in the manifest`);
  return c;
});

// The smoke subset never uses the emulators on purpose; javac may be missing on a machine (loud warning below); CORPUS_ALLOW_SKIP_TIERS adds more.
const SMOKE_ALLOWED_TIERS = ["spanner", "bigquery", "java", ...allowedSkipTiersFromEnv()];

describe("corpus smoke", () => {
  let results: CaseResult[] = [];
  beforeAll(async () => {
    results = await runCases(cases, { emulators: false, roundTrip: false, concurrency: 4, caseConcurrency: 2 });
  }, 150_000);

  it("says so loudly when javac is missing (the java-pojo output is then not compiled)", () => {
    const javaSkipped = results.some((r) => Object.values(r.targets).some((o) => o?.tierSkipped?.tier === "java"));
    if (javaSkipped) process.stdout.write("\n[corpus-smoke] WARNING: javac is not available, the java-pojo outputs of the smoke subset were NOT compiled\n");
    expect(true).toBe(true);
  });

  it("generates every enabled target for every smoke case", () => {
    for (const r of results) for (const t of enabledTargets()) expect(r.targets[t], `${r.id} ${t}`).toBeDefined();
  });

  for (const c of cases) {
    it(`${c.id}: no unexpected failure`, () => {
      const result = results.find((r) => r.id === c.id)!;
      // The smoke subset never uses the emulators on purpose (explicit option); every other tier (javac, PGlite, ...) must run.
      expect(problemsOf(result, { allowSkipTiers: SMOKE_ALLOWED_TIERS, allowedSkips: c.expectations.allowedSkips })).toEqual([]);
    });
  }
});
