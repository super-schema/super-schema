import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, err, type Result } from "@/types/result";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { generateClosureTypeSpec } from "@/lib/compiler/closure-source";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";
import { upgradeLegacyTagDecorators } from "@/lib/compiler/legacy-tag-decorators";
import type { ReferenceClosure } from "@/lib/references/closure";

type Db = PrismaClient | Prisma.TransactionClient;

/** What the publish gate compiles: the entities of a closure (`loadPublishClosure` returns one). */
type GateClosure = Pick<ReferenceClosure, "entities">;

export interface ResolveSourceDeps {
  loadModel: (db: Db, entityId: string) => Promise<Result<SuperSchemaModel>>;
  /** The entity's OWN TypeSpec text: what a publish freezes. */
  generate: (model: SuperSchemaModel) => string;
  /** The combined TypeSpec of the whole closure (every entity in its own namespace): what the gate compiles. */
  generateClosure: (closure: GateClosure) => string;
  compile: (source: string) => Promise<{
    success: boolean;
    diagnostics: Array<{ severity: string; code: string; message: string }>;
  }>;
}

/** The closure document is the emission projection plus the governance overlay the entity's own text carries; no target import. */
const GATE_TARGET = "publish-gate";

const defaultDeps: ResolveSourceDeps = {
  loadModel: loadEntityModel,
  generate: generateTypeSpec,
  generateClosure: (closure) => generateClosureTypeSpec(closure, { target: GATE_TARGET, governance: true }).source,
  compile: compileTypeSpecWithGovernance,
};

/** True when publish must regenerate the source: there is none stored, or field/entity edits left it stale. */
export function needsRegeneration(stored: string | null, stale: boolean): boolean {
  return !stored || stale;
}

/**
 * Phase 2 for a fresh stored source (no regeneration): it is frozen verbatim — except that a source stored
 * before Story 16.6 may still carry the invalid `@tag("...")` decorators (a publish wrote the generator's
 * text back into `entity.typespecSource`), which would freeze uncompilable text into an immutable version.
 * `upgradeLegacyTagDecorators` rewrites them losslessly; when it changed anything the caller freezes the
 * upgraded text and writes it back in the same transaction (`upgraded`), so the canonical source stays equal
 * to the frozen one. A current source comes back unchanged and untouched (`upgraded: false`).
 */
export function freezableStoredSource(stored: string): { source: string; upgraded: boolean } {
  const source = upgradeLegacyTagDecorators(stored);
  return { source, upgraded: source !== stored };
}

/**
 * The publish compile gate: the REAL closure (the entity being published at its saved rows, everything it references at its
 * published version, see `loadPublishClosure`) is generated as one combined TypeSpec document and compiled. There are no stand-in
 * models: a reference to an entity of the closure is typed with that entity's real model, and a reference that matches no entity
 * stays dangling and is typed `unknown`, exactly as emission does, so the gate agrees with what a consumer will later emit.
 * A source that does not compile blocks the publish with the compiler's diagnostics. Compiles once; runs OUTSIDE the publish lock
 * and transaction, so a slow compile never holds a row lock or the single PGlite connection.
 */
export async function compileClosure(closure: GateClosure, deps: Partial<ResolveSourceDeps> = {}): Promise<Result<void>> {
  const { generateClosure, compile } = { ...defaultDeps, ...deps };
  const compiled = await compile(generateClosure(closure));
  if (!compiled.success) {
    const errors = compiled.diagnostics.filter((d) => d.severity === "error");
    const summary = (errors.length > 0 ? errors : compiled.diagnostics)
      .slice(0, 3)
      .map((d) => d.message)
      .join("; ");
    return err({
      code: "PUBLISH_BLOCKED",
      message: `The TypeSpec generated from the fields does not compile: ${summary}`,
      details: { diagnostics: compiled.diagnostics },
      suggestedFix: "Fix the reported fields (or the TypeSpec source), then publish again.",
    });
  }
  return ok(undefined);
}

/**
 * Phase 1 of the source the publish freezes (controller rulings R42, R45, R46): regenerate it from
 * the entity and field rows and gate the closure it belongs to with the real compiler
 * ({@link compileClosure}). Runs OUTSIDE the publish lock and transaction.
 *
 * `entity.typespecSource` is canonical, but name, description, tags and other metadata and the field
 * rows are all rendered into it; every edit outside the TypeSpec source tab sets
 * `metadata.sourceStale`. A source that does not compile blocks the publish with the diagnostics.
 *
 * What the compiler sees is the combined closure document; what this returns, and what the caller stores and freezes, is the
 * entity's OWN generated text (the generator's own text: since Story 16.6 it emits valid governance decorators
 * (`@Enterprise.dataClassification`, `x-classification`, `x-tags`) instead of `@tag(...)`), which names a referenced entity by its
 * bare name as before.
 *
 * Trade-off: regeneration works from the field rows, so TypeSpec that fields cannot represent is not
 * carried over. If such constructs (custom decorators, unions, hand-declared enums, scalars or nested
 * models used as field types, anything the generator does not emit) were saved on the TypeSpec tab and
 * the entity was then edited anywhere else, publishing regenerates the source from the fields: those
 * constructs are dropped, and field types that referred to hand-declared enums, scalars or nested
 * models collapse to `string` in the frozen source. A fresh, field-representable source is preferred
 * over a frozen source that silently lacks the latest edits.
 */
export async function compileRegeneratedSource(
  db: Db,
  entityId: string,
  closure: GateClosure,
  deps: Partial<ResolveSourceDeps> = {}
): Promise<Result<string>> {
  const { loadModel, generate } = { ...defaultDeps, ...deps };
  const model = await loadModel(db, entityId);
  if (!model.success) return model;

  const generated = generate(model.data);
  const gated = await compileClosure(closure, deps);
  if (!gated.success) return gated;
  return ok(generated);
}

/**
 * Phase 2, inside the publish transaction after the row lock: the compile in phase 1 only vouches
 * for the exact text it compiled. Regenerate the text from the now-locked rows (pure, no compile)
 * and require it to be identical; otherwise an edit landed in between and the publish aborts with a
 * retryable error. Comparing the generated text is exact (it is the compiler's input) and, unlike
 * comparing `updatedAt`, does not abort for bookkeeping writes the source does not render.
 */
export async function confirmRegeneratedSource(
  db: Db,
  entityId: string,
  precompiled: string,
  deps: Partial<ResolveSourceDeps> = {}
): Promise<Result<void>> {
  const { loadModel, generate } = { ...defaultDeps, ...deps };
  const model = await loadModel(db, entityId);
  if (!model.success) return model;
  if (generate(model.data) !== precompiled) {
    return err({
      code: "CONFLICT",
      message: "Entity changed during publish, try again",
      suggestedFix: "Publish again.",
    });
  }
  return ok(undefined);
}
