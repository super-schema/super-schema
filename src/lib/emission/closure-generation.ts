/**
 * What every entry point that generates a closure (the entity page action, the emit / validate routes, the all-targets run) shares:
 * how a closure that could not be built is reported, what a generation records about the versions it used, and a closure emission
 * folded into the same result shape as every other target.
 */

import type { ClosureError, ReferenceClosure, ResolveMode } from "@/lib/references/closure";
import { describeEntityRef, type EntityRef } from "@/lib/references/entity-reference";
import { bundleEmittedFiles, emitClosure, type Closure, type EmittedFile } from "@/lib/typespec-official/closure-emit";
import { resultFromEmissionError, type OfficialTypeSpecTargetResult } from "@/lib/typespec-official/emitter.service";
import type { TargetId } from "@/lib/schema-targets/catalog";
import type { ServiceError } from "@/types/result";
import type { SchemaVersionResolution } from "@/types/schema-version";

/** A target result that also carries the structured file list (closure targets only; every other target has no `files`). */
export type ClosureTargetResult = OfficialTypeSpecTargetResult & { files?: EmittedFile[] };

/** `domain / product / entity`: how a person reads a qualified name (the stored form is `domain/product/entity`). */
const describeRef = (ref: EntityRef): string => describeEntityRef(ref);

/**
 * A closure that could not be built, as a `ServiceError` every caller can map: the code is the closure's own, except a root outside
 * the tenant, which reads exactly like a missing entity. `AMBIGUOUS_REFERENCE` carries the candidates and the field to pick for
 * (`details`), so a non-interactive caller returns it as is and an interactive one opens the pick dialog.
 */
export function closureFailure(error: ClosureError): ServiceError {
  switch (error.code) {
    case "AMBIGUOUS_REFERENCE":
      if (error.frozen) {
        // The field sits in a published (or pinned) version: it cannot be edited, so a pick on the closure's behalf would not help. The
        // pick the user makes on the owner's field is written to its live row and used by the owner's NEXT version.
        const owner = error.owner.entity;
        return {
          code: error.code,
          message: `This published version of ${owner} refers to "${error.name}" by name and ${error.candidates.length} entities have that name: ${error.candidates.map(describeRef).join("; ")}. Publish ${owner} again (open ${owner} and choose which one its field "${error.field}" means: the pick you make now is used by its next version), or pin a version of ${owner} that refers to it by its full name.`,
          details: { field: error.field, name: error.name, candidates: error.candidates, entityId: error.entityId, fieldId: error.fieldId, frozen: true },
          suggestedFix: `Choose the entity on ${owner}'s field and publish ${owner} again, or pin a version of ${owner} that uses the full name.`,
        };
      }
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
    case "AMBIGUOUS_BASE":
      return {
        code: error.code,
        message: `${error.owner.entity} extends "${error.name}", which matches ${error.candidates.length} entities: ${error.candidates.map(describeRef).join("; ")}. Rename the base so one of them is nearer (same product), or extend a name only one entity has.`,
        details: { name: error.name, candidates: error.candidates, owner: error.owner },
      };
    case "INHERITANCE_CYCLE":
      return {
        code: error.code,
        message: `These entities extend each other in a circle: ${error.chain.map((ref) => ref.entity).join(" -> ")}. Remove one of the \`extends\`.`,
        details: { chain: error.chain },
      };
    case "CLOSURE_TOO_LARGE":
      return {
        code: error.code,
        message: `The schema references more than ${error.limit} entities, directly or through other entities. Shorten the chain of references.`,
        details: { limit: error.limit },
      };
    case "REFERENCE_NOT_READABLE":
      // KD-045. Names the caller's OWN field and nothing of the entity it points at (not its name, domain, product, id or version): the caller
      // may hold no role that covers it, and the answer must not tell them what is there.
      return {
        code: error.code,
        message: `Field "${error.field}" refers to an entity that none of your roles covers, so this schema cannot be generated from here.`,
        details: { field: error.field },
        suggestedFix: "Ask an administrator for a role that covers the referenced entity, or remove the reference.",
      };
    case "CROSS_TENANT":
      return { code: "NOT_FOUND", message: "Entity not found" };
  }
}

/**
 * The pick a closure refusal asks for, in the shape `generateSchemaAction` answers as `needsReference` (the field, the name it refers to,
 * the entities that name matches, and the entity + field row that hold it), or undefined when the refusal is not a question: any other
 * code, details that are not the expected shape, or a name frozen in a published or pinned snapshot (a pick cannot change it).
 */
export function pickRequestOfRefusal(refusal: { code: string; message?: string; details?: unknown } | undefined):
  | { field: string; name: string; candidates: EntityRef[]; entityId: string; fieldId: string }
  | undefined {
  if (!refusal || refusal.code !== "AMBIGUOUS_REFERENCE" || !refusal.details || typeof refusal.details !== "object") return undefined;
  const d = refusal.details as Record<string, unknown>;
  if (d.frozen === true) return undefined;
  if (typeof d.field !== "string" || typeof d.name !== "string" || !Array.isArray(d.candidates) || typeof d.entityId !== "string" || typeof d.fieldId !== "string") return undefined;
  return { field: d.field, name: d.name, candidates: d.candidates as EntityRef[], entityId: d.entityId, fieldId: d.fieldId };
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
