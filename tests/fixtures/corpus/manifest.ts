/**
 * The corpus manifest: every case (JSON Schema documents, direct TypeSpec super schemas, hand-built entities) in a deterministic order.
 * The runner is tests/integration/corpus/corpus.test.ts (CORPUS=1); the always-on subset is SMOKE_CASE_IDS.
 */
import type { CorpusCase } from "./types";
import { JSONSCHEMA_CASES } from "./jsonschema-cases";
import { TYPESPEC_CASES } from "./typespec-cases";
import { MODEL_CASES } from "./model-cases";
import { REFERENCE_CASES } from "./reference-cases";

export type { CorpusCase, CorpusExpectations, CorpusKind, TargetKey, ModelInput, Placement, PublishedSnapshot } from "./types";
export { ALL_TARGETS } from "./types";

export const CORPUS: CorpusCase[] = [...JSONSCHEMA_CASES, ...TYPESPEC_CASES, ...MODEL_CASES, ...REFERENCE_CASES];

/** The small always-on subset (kept under ~60 s with every target, no emulators). */
export const SMOKE_CASE_IDS = [
  "js-user-event",
  "js-realistic-order",
  "js-classification-default",
  "tsp-basic-model",
  "tsp-enum-inline",
  "model-family-number",
] as const;

const ids = new Set<string>();
for (const c of CORPUS) {
  if (ids.has(c.id)) throw new Error(`duplicate corpus id ${c.id}`);
  ids.add(c.id);
}
