/**
 * Generates every enabled target for a built case and classifies the outcome:
 *   PASS | DEGRADED | NEEDS_INPUT | FAIL(reason) | SKIPPED(reason)
 * Targets that need a primary key (bigquery, postgresql, spanner) get one the way the app's dialog does: the suggested
 * candidate (or the first eligible one); with no eligible candidate the outcome is NEEDS_INPUT, not a failure.
 */
import type { PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { activeDanglingRef } from "@/lib/field-dangling";
import { getTargetRequirements } from "@/lib/schema-targets/requirements";
import { supportsClosureEmission } from "@/lib/schema-targets/catalog";
import { loadReferenceClosure } from "@/lib/references/closure";
import { qualifiedName } from "@/lib/references/entity-reference";
import type { OfficialTypeSpecTargetResult } from "@/lib/typespec-official/emitter.service";
import type { BuiltCase } from "./build-rows";
import { CORPUS_TENANT, createMemoryDb } from "./memory-db";
import type { CorpusCase, TargetKey } from "../../fixtures/corpus/types";

export type OutcomeKind = "PASS" | "DEGRADED" | "NEEDS_INPUT" | "FAIL" | "SKIPPED";

/** What a closure emission produced besides the text: the files (path, content, entity) and the entities the closure walked. */
export interface ClosureFacts {
  /** The files written; `content` is dropped once the output has been validated (the results of a whole corpus run are kept in memory). */
  files: Array<{ path: string; content?: string; entityId?: string }>;
  /** The qualified names of the closure's entities, the case's own first. */
  entities: string[];
  /** Entities whose content was read at a pinned version, by qualified name. */
  pinned: string[];
  cycles: string[][];
}

export interface TargetOutcome {
  target: TargetKey;
  kind: OutcomeKind;
  reason?: string;
  /** The bundled `===== path =====` output (a single file is its bare content), the form `SchemaVersion.output` stores. */
  output?: string;
  /** Present for the closure targets (json-schema, openapi3, avro, protobuf, java-pojo). */
  closure?: ClosureFacts;
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

/** A result of a closure emission, with what the closure walked (the corpus's validators and tests read it). */
type EmittedResult = OfficialTypeSpecTargetResult & { closure?: ClosureFacts };

/**
 * One closure target of a built case, generated the way the app does it: the case's own entity is the ROOT, the closure is loaded by the
 * real resolver over the case's tenant (DRAFT mode: the current saved state, which is what the Schemas tab generates), and `emitClosure`
 * writes one file per entity. A closure the resolver refuses (an ambiguous bare name, a pin that does not exist) is an INVALID result
 * that says so, like the app's answer.
 *
 * `fields` are the root's fields (the primary-key answer for a DB target lands here; the closure targets need none).
 */
export async function emitCaseClosure(built: BuiltCase, fields: PrismaFieldInput[], target: TargetKey): Promise<EmittedResult> {
  const { emitClosure, bundleEmittedFiles } = await import("@/lib/typespec-official/closure-emit");
  const { resultFromEmissionError } = await import("@/lib/typespec-official/emitter.service");
  const members = built.members.map((m, i) => (i === 0 ? { ...m, fields } : m));
  const loaded = await loadReferenceClosure(createMemoryDb(members), CORPUS_TENANT, members[0].entity.id, "draft");
  if (!loaded.success) {
    const e = loaded.error;
    const detail = e.code === "AMBIGUOUS_REFERENCE" ? `field "${e.field}" names "${e.name}", which matches ${e.candidates.map((c) => qualifiedName(c)).join(", ")}`
      : e.code === "PIN_NOT_FOUND" ? `field "${e.field}" pins ${qualifiedName(e.ref)} v${e.version}, which does not exist`
      : e.code === "NEVER_PUBLISHED" ? `${qualifiedName(e.ref)} was never published`
      : e.code === "CLOSURE_TOO_LARGE" ? `more than ${e.limit} entities` : "the entity is not in the tenant";
    return { output: "", validationStatus: "INVALID", warnings: [], errors: [{ message: `reference-closure ${e.code}: ${detail}` }] };
  }
  const closure = loaded.data;
  const emitted = await emitClosure(closure, target);
  if (!emitted.success) return resultFromEmissionError(emitted.error);
  const { files, warnings } = emitted.data;
  return {
    output: bundleEmittedFiles(files),
    validationStatus: warnings.length > 0 ? "WARNING" : "VALID",
    warnings,
    errors: [],
    closure: {
      files: files.map((f) => ({ path: f.path, content: f.content, entityId: f.entityId })),
      entities: closure.entities.map((e) => qualifiedName(e.ref)),
      pinned: closure.entities.filter((e) => e.source === "pinned").map((e) => qualifiedName(e.ref)),
      cycles: closure.cycles,
    },
  };
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
    // The schema targets take the whole reference closure of the case's entity (one file per entity); the DB targets emit the entity on
    // its own, a reference being a plain column there.
    const result: EmittedResult = await limit(() => withTimeout(
      supportsClosureEmission(target) ? emitCaseClosure(built, pk.fields, target) : emitOfficialTypeSpecTargetFromData(built.entity, pk.fields, target),
      timeoutMs, `emit ${target}`,
    ));
    const emitMs = Date.now() - t0;
    const warnings = result.warnings ?? [];
    if (result.validationStatus === "INVALID" || result.errors.length > 0) {
      const detail = result.errors.map((e) => (e as { message?: string }).message ?? JSON.stringify(e)).join(" | ").slice(0, 600);
      return { target, kind: "FAIL", reason: detail || "INVALID with no message", warnings, keyField: pk.keyField };
    }
    const degraded = c.expectations.expectedDegraded?.find((d) => d.target === target);
    const isDegraded = warnings.length > 0 || result.validationStatus === "WARNING";
    return {
      target, kind: isDegraded ? "DEGRADED" : "PASS", output: result.output, closure: result.closure, warnings, keyField: pk.keyField, emitMs,
      ...(degraded ? { reason: degraded.reason } : isDegraded ? { reason: warnings[0]?.slice(0, 200) } : {}),
    };
  } catch (error) {
    return { target, kind: "FAIL", reason: `threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600), warnings: [], keyField: pk.keyField };
  }
}
