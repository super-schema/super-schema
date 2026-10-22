/**
 * The full corpus: every case x every enabled target, with validators (offline + LocalCloud emulators) and JSON Schema round trips.
 * Opt-in: `npm run test:corpus` (CORPUS=1). Filters: CORPUS_IDS=<regex>, CORPUS_NO_EMULATORS=1, CORPUS_BUDGET_MIN=<minutes, default 25>.
 * A full (unfiltered) run rewrites docs/superpowers/reports/2026-10-22-corpus-matrix.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CORPUS } from "../../fixtures/corpus/manifest";
import { runCases, problemsOf, enabledTargets, type CaseResult } from "../../helpers/corpus/orchestrate";
import { renderMatrix } from "../../helpers/corpus/matrix";
import { createdBigQuery, createdSpanner, probeEmulators, RUN_ID, sweep } from "../../helpers/corpus/emulators";

vi.mock("server-only", () => ({}));

const enabled = process.env.CORPUS === "1";
const filter = process.env.CORPUS_IDS ? new RegExp(process.env.CORPUS_IDS) : undefined;
const cases = CORPUS.filter((c) => !filter || filter.test(c.id));
const REPORT = process.env.CORPUS_REPORT_PATH ?? path.join(process.cwd(), "docs/superpowers/reports/2026-10-22-corpus-matrix.md");

if (!enabled) {
  describe("corpus (skipped)", () => {
    it.skip("set CORPUS=1 (npm run test:corpus) to generate every target from the whole corpus and validate it", () => {});
  });
} else {
  describe("corpus", () => {
    let results: CaseResult[] = [];
    let started = 0;

    beforeAll(async () => {
      started = Date.now();
      const emulators = process.env.CORPUS_NO_EMULATORS !== "1";
      results = await runCases(cases, {
        emulators, roundTrip: true, concurrency: 4, caseConcurrency: 3,
        budgetMs: Number(process.env.CORPUS_BUDGET_MIN ?? 25) * 60_000,
        onProgress: (done, total, id) => { if (done % 20 === 0) process.stdout.write(`[corpus] ${done}/${total} (${id})\n`); },
      });
    }, 45 * 60_000);

    afterAll(async () => {
      const remaining = await sweep();
      const state = process.env.CORPUS_NO_EMULATORS === "1" ? { spanner: false, bigquery: false, reasons: ["CORPUS_NO_EMULATORS=1"] } : await probeEmulators();
      const markdown = renderMatrix(results, {
        runId: RUN_ID, targets: enabledTargets(), emulators: state, ms: Date.now() - started,
        cleanup: { ...remaining, created: { spanner: createdSpanner.length, bigquery: createdBigQuery.length } },
      });
      if (!filter || process.env.CORPUS_REPORT_PATH) {
        mkdirSync(path.dirname(REPORT), { recursive: true });
        writeFileSync(REPORT, markdown);
      }
      const totals = enabledTargets().map((t) => {
        const c = (k: string): number => results.filter((r) => r.targets[t]?.kind === k).length;
        const sum = (k: "emitMs" | "validateMs"): number => Math.round(results.reduce((a, r) => a + (r.targets[t]?.[k] ?? 0), 0) / 1000);
        return `${t}: PASS ${c("PASS")} DEGRADED ${c("DEGRADED")} NEEDS_INPUT ${c("NEEDS_INPUT")} FAIL ${c("FAIL")} (known ${results.filter((r) => r.targets[t]?.kind === "FAIL" && r.targets[t]?.expected).length}) SKIPPED ${c("SKIPPED")}  [emit ${sum("emitMs")} s, validate ${sum("validateMs")} s]`;
      });
      process.stdout.write(`\n[corpus] summary (${results.length} cases)\n${totals.join("\n")}\n[corpus] leftover emulator objects: ${JSON.stringify(remaining)}\n`);
    }, 120_000);

    it("leaves no emulator object behind", async () => {
      const remaining = await sweep();
      expect(remaining).toEqual({ spanner: [], bigquery: [] });
    });

    for (const c of cases) {
      it(`${c.id}: ${c.title}`, () => {
        const result = results.find((r) => r.id === c.id);
        expect(result, "case did not run").toBeDefined();
        expect(problemsOf(result!)).toEqual([]);
      });
    }
  });
}
