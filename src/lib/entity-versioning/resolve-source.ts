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

export interface ResolvedDraftSource {
  source: string;
  /** True when the source was regenerated from the field rows (the caller must write it back). */
  regenerated: boolean;
}

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

/**
 * The source Publish freezes as `resolvedSource` (controller ruling R42).
 *
 * `entity.typespecSource` is canonical, but paths that write field rows without the TypeSpec source
 * save (quick field editor, REST/tRPC, TypeSpec preview apply) leave it behind and set
 * `metadata.sourceStale`. When the source is stale or missing, regenerate it from the field rows and
 * gate it with the real compiler; a source that does not compile blocks the publish with the
 * diagnostics. The caller writes a regenerated source back to the entity inside the publish transaction.
 *
 * Trade-off: if hand-written TypeSpec constructs that fields cannot represent (custom decorators,
 * unions, anything the generator does not emit) were saved on the TypeSpec tab and the entity was then
 * edited in the quick field editor, publishing regenerates the source from the fields and those
 * constructs are dropped. A fresh, fully field-representable source is preferred over a frozen source
 * that silently lacks the latest field edits.
 */
export async function resolveDraftSource(
  db: Db,
  entityId: string,
  stored: string | null,
  stale: boolean,
  deps: ResolveSourceDeps = defaultDeps
): Promise<Result<ResolvedDraftSource>> {
  if (stored && !stale) return ok({ source: stored, regenerated: false });

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
  return ok({ source: generated, regenerated: true });
}
