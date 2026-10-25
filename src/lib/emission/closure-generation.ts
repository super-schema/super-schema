/**
 * What every entry point that generates a closure (the entity page action, the emit / validate routes, the all-targets run) shares:
 * how a closure that could not be built is reported, what a generation records about the versions it used, and a closure emission
 * folded into the same result shape as every other target.
 */

import type { ClosureError, ReferenceClosure, ResolveMode } from "@/lib/references/closure";
import { qualifiedName, type EntityRef } from "@/lib/references/entity-reference";
import { bundleEmittedFiles, emitClosure, type Closure, type EmittedFile } from "@/lib/typespec-official/closure-emit";
import { resultFromEmissionError, type OfficialTypeSpecTargetResult } from "@/lib/typespec-official/emitter.service";
import type { TargetId } from "@/lib/schema-targets/catalog";
import type { ServiceError } from "@/types/result";
import type { SchemaVersionResolution } from "@/types/schema-version";

/** A target result that also carries the structured file list (closure targets only; every other target has no `files`). */
export type ClosureTargetResult = OfficialTypeSpecTargetResult & { files?: EmittedFile[] };

/** `domain / product / entity`: how a person reads a qualified name (the stored form is `domain/product/entity`). */
const describeRef = (ref: EntityRef): string => qualifiedName(ref).split("/").join(" / ");

/**
 * A closure that could not be built, as a `ServiceError` every caller can map: the code is the closure's own, except a root outside
 * the tenant, which reads exactly like a missing entity. `AMBIGUOUS_REFERENCE` carries the candidates and the field to pick for
 * (`details`), so a non-interactive caller returns it as is and an interactive one opens the pick dialog.
 */
export function closureFailure(error: ClosureError): ServiceError {
  switch (error.code) {
    case "AMBIGUOUS_REFERENCE":
      return {
        code: error.code,
        message: `Field "${error.field}" refers to "${error.name}", which matches ${error.candidates.length} entities: ${error.candidates.map(describeRef).join("; ")}. Choose which one it means.`,
        details: { field: error.field, name: error.name, candidates: error.candidates, entityId: error.entityId, fieldId: error.fieldId },
        suggestedFix: "Pick the entity the field refers to (it is then saved as a fully qualified reference) and generate again.",
      };
    case "PIN_NOT_FOUND":
      return {
        code: error.code,
        message: `Field "${error.field}" pins version ${error.version} of ${describeRef(error.ref)}, which does not exist or is not published. Unpin it or pin a published version.`,
        details: { field: error.field, ref: error.ref, version: error.version },
      };
    case "PIN_CONFLICT":
      return {
        code: error.code,
        message: `${describeRef(error.ref)} is pinned to different versions: ${error.pins.map((pin) => `${pin.owner.entity}.${pin.field} pins ${pin.version}`).join("; ")}. A schema uses one version of each entity: pin the same version on every field that refers to it, or unpin all but one.`,
        details: { ref: error.ref, pins: error.pins },
      };
    case "NEVER_PUBLISHED":
      return {
        code: error.code,
        message: `${describeRef(error.ref)} has never been published, so a published schema cannot use it. Publish it first, or generate the draft instead.`,
        details: { ref: error.ref },
      };
    case "CLOSURE_TOO_LARGE":
      return {
        code: error.code,
        message: `The schema references more than ${error.limit} entities, directly or through other entities. Shorten the chain of references.`,
        details: { limit: error.limit },
      };
    case "CROSS_TENANT":
      return { code: "NOT_FOUND", message: "Entity not found" };
  }
}

/**
 * What a generation records about the versions it used (see `SchemaVersionResolution`): the root first, then what it references.
 * `preview` is true when any of them came from unpublished rows, which makes the output a preview that cannot be published as is.
 */
export function describeResolution(
  closure: Pick<ReferenceClosure, "entities" | "draftEntities"> & Partial<Pick<ReferenceClosure, "notes">>,
  mode: ResolveMode
): SchemaVersionResolution {
  return {
    mode,
    preview: closure.draftEntities.length > 0,
    entities: closure.entities.map((entity) => ({
      ref: { ...entity.ref },
      ...(entity.version ? { version: entity.version } : {}),
      source: entity.source,
    })),
    ...(closure.notes && closure.notes.length > 0 ? { notes: [...closure.notes] } : {}),
  };
}

/**
 * Emits one closure target as a target result: `output` is the bundled `===== path =====` string of `files` (what a schema version
 * stores as `output`), and an emission that failed is an INVALID result carrying the emitter's own messages. Never throws.
 */
export async function emitClosureTarget(closure: Closure, targetKey: TargetId): Promise<ClosureTargetResult> {
  const emitted = await emitClosure(closure, targetKey);
  if (!emitted.success) return resultFromEmissionError(emitted.error);
  const { files, warnings } = emitted.data;
  return { output: bundleEmittedFiles(files), files, validationStatus: warnings.length > 0 ? "WARNING" : "VALID", warnings, errors: [] };
}
