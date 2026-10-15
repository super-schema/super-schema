import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { ok, err, type Result } from "@/types/result";
import type { SuperSchemaModel } from "@/types/super-schema-model";
import { loadEntityModel } from "@/lib/compiler/entity-model-loader";
import { generateTypeSpec, sanitizeIdentifier } from "@/lib/compiler/typespec-generator";
import { compileTypeSpecWithGovernance } from "@/lib/compiler/typespec-compiler";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ResolveSourceDeps {
  loadModel: (db: Db, entityId: string) => Promise<Result<SuperSchemaModel>>;
  generate: (model: SuperSchemaModel) => string;
  compile: (source: string) => Promise<{
    success: boolean;
    diagnostics: Array<{ severity: string; code: string; message: string }>;
  }>;
}

const defaultDeps: ResolveSourceDeps = {
  loadModel: loadEntityModel,
  generate: generateTypeSpec,
  compile: compileTypeSpecWithGovernance,
};

/** Names of the models this entity's source refers to but does not define (reference targets, parent, spreads). */
export function referencedModelNames(model: SuperSchemaModel): string[] {
  const names = new Set<string>();
  for (const field of model.fields) {
    const target = field.complexType?.referencedEntityName;
    if (target) names.add(sanitizeIdentifier(target));
  }
  if (model.entity.parentEntityName) names.add(sanitizeIdentifier(model.entity.parentEntityName));
  for (const spread of model.entity.spreadFrom ?? []) names.add(sanitizeIdentifier(spread));
  return [...names];
}

/**
 * Append an empty `model X {}` for every referenced name the source does not declare. An entity's
 * source is not self-contained until the Data Type / reference closure lands (Phase 2b): a reference
 * field is emitted as the bare target name. The stubs exist only so the compile gate can judge the
 * rest of the source; they are never stored or frozen.
 */
export function stubUnresolvedReferences(source: string, names: string[]): string {
  const stubs = names.filter(
    (name) => !new RegExp(`\\b(?:model|enum|scalar|union|interface|alias)\\s+${name}\\b`).test(source)
  );
  if (stubs.length === 0) return source;
  return `${source}\n${stubs.map((name) => `model ${name} {}`).join("\n")}\n`;
}

/** True when publish must regenerate the source: there is none stored, or field/entity edits left it stale. */
export function needsRegeneration(stored: string | null, stale: boolean): boolean {
  return !stored || stale;
}

/**
 * Phase 1 of the source the publish freezes (controller rulings R42, R45, R46): regenerate it from
 * the entity and field rows and gate it with the real compiler. Runs OUTSIDE the publish lock and
 * transaction, so a slow compile never holds a row lock or the single PGlite connection.
 *
 * `entity.typespecSource` is canonical, but name, description, tags and other metadata and the field
 * rows are all rendered into it; every edit outside the TypeSpec source tab sets
 * `metadata.sourceStale`. A source that does not compile blocks the publish with the diagnostics.
 *
 * The text handed to the compiler differs from the generated text in one way, for the check only:
 * unresolved reference names get empty stub models (`stubUnresolvedReferences`). Nothing is stripped —
 * since Story 16.6 the generator emits valid governance decorators (`@Enterprise.dataClassification`,
 * `x-classification`, `x-tags`) instead of `@tag(...)`. What this returns, and what the caller stores and
 * freezes, is the generator's own text.
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
  deps: ResolveSourceDeps = defaultDeps
): Promise<Result<string>> {
  const model = await deps.loadModel(db, entityId);
  if (!model.success) return model;

  const generated = deps.generate(model.data);
  const compiled = await deps.compile(stubUnresolvedReferences(generated, referencedModelNames(model.data)));
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
  deps: ResolveSourceDeps = defaultDeps
): Promise<Result<void>> {
  const model = await deps.loadModel(db, entityId);
  if (!model.success) return model;
  if (deps.generate(model.data) !== precompiled) {
    return err({
      code: "CONFLICT",
      message: "Entity changed during publish, try again",
      suggestedFix: "Publish again.",
    });
  }
  return ok(undefined);
}
