/**
 * Generates every enabled target for a built case and classifies the outcome:
 *   PASS | DEGRADED | NEEDS_INPUT | FAIL(reason) | SKIPPED(reason)
 * Targets that need a primary key (bigquery, postgresql, spanner) get one the way the app's dialog does: the suggested
 * candidate (or the first eligible one); with no eligible candidate the outcome is NEEDS_INPUT, not a failure.
 */
import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { activeDanglingRef } from "@/lib/field-dangling";
import { getTargetRequirements } from "@/lib/schema-targets/requirements";
import type { BuiltCase } from "./build-rows";
import type { CorpusCase, TargetKey } from "../../fixtures/corpus/types";

export type OutcomeKind = "PASS" | "DEGRADED" | "NEEDS_INPUT" | "FAIL" | "SKIPPED";
export interface TargetOutcome {
  target: TargetKey;
  kind: OutcomeKind;
  reason?: string;
  output?: string;
  warnings: string[];
  /** The validator tier that judged the output (or why none ran). */
  validator?: string;
  /** Marked as a known (expectedFailures) result: the matrix shows it, the suite stays green. */
  expected?: string;
  /** The registry rule (or `case-expectation`) that explains this FAIL. */
  knownId?: string;
  /** The validator tier that could not run (and why): spanner, bigquery or java. A CORPUS=1 run fails on it unless it is allowed. */
  tierSkipped?: { tier: "spanner" | "bigquery" | "java"; reason: string };
  keyField?: string;
  /** Wall time of the emit (emitMs) and of the validator (validateMs). */
  emitMs?: number;
  validateMs?: number;
}

/** Counting semaphore so that at most N `tsp compile` children run at once. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active -= 1; queue.shift()?.(); };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try { return await task(); } finally { next(); }
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The primary key the app would pre-select for `target`, applied to the fields; or the reason it cannot be chosen. */
export function applyPrimaryKey(built: BuiltCase, target: TargetKey): { fields: PrismaFieldInput[]; needsInput?: string; keyField?: string } {
  const shape = {
    name: built.entity.name,
    fields: built.fields.map((f) => ({
      name: f.name, isKey: f.isKey, nullable: f.nullable, type: f.type,
      dangling: activeDanglingRef(f.type, f.decorators as { danglingRef?: unknown; arrayElementType?: unknown }) !== undefined,
    })),
  };
  const { missing } = getTargetRequirements(target, shape);
  const pk = missing.find((m) => m.code === "primary-key");
  if (!pk) return { fields: built.fields };
  const choice = pk.suggested[0] ?? pk.candidates[0];
  if (!choice) return { fields: built.fields, needsInput: `no eligible primary-key candidate (${pk.message})` };
  return { fields: built.fields.map((f) => (f.name === choice ? { ...f, isKey: true } : f)), keyField: choice };
}

export async function generateTarget(
  c: CorpusCase,
  built: BuiltCase,
  target: TargetKey,
  limit: ReturnType<typeof createLimiter>,
  timeoutMs: number,
): Promise<TargetOutcome> {
  const { emitOfficialTypeSpecTargetFromData } = await import("@/lib/typespec-official/emitter.service");
  const pk = applyPrimaryKey(built, target);
  if (pk.needsInput) return { target, kind: "NEEDS_INPUT", reason: pk.needsInput, warnings: [] };
  const t0 = Date.now();
  try {
    const result = await limit(() => withTimeout(emitOfficialTypeSpecTargetFromData(built.entity, pk.fields, target), timeoutMs, `emit ${target}`));
    const emitMs = Date.now() - t0;
    const warnings = result.warnings ?? [];
    if (result.validationStatus === "INVALID" || result.errors.length > 0) {
      const detail = result.errors.map((e) => (e as { message?: string }).message ?? JSON.stringify(e)).join(" | ").slice(0, 600);
      return { target, kind: "FAIL", reason: detail || "INVALID with no message", warnings, keyField: pk.keyField };
    }
    const degraded = c.expectations.expectedDegraded?.find((d) => d.target === target);
    const isDegraded = warnings.length > 0 || result.validationStatus === "WARNING";
    return {
      target, kind: isDegraded ? "DEGRADED" : "PASS", output: result.output, warnings, keyField: pk.keyField, emitMs,
      ...(degraded ? { reason: degraded.reason } : isDegraded ? { reason: warnings[0]?.slice(0, 200) } : {}),
    };
  } catch (error) {
    return { target, kind: "FAIL", reason: `threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600), warnings: [], keyField: pk.keyField };
  }
}
