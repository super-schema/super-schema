// src/services/events/pin-json-schema.service.ts
// The JSON Schema of one entity pin, for the builder's message examples: the editor checks an example's payload / headers against it
// and "Generate from payload" builds the example from it. Read-only; nothing is written.
//
// Rendered exactly as the message's payload is for the Code panel: a pinned version renders that immutable version, an unpinned pin
// the entity's current draft. The renderer's JSON Schema (2020-12, its bundle inlined into local `$defs`) is down-converted to
// draft-07, the dialect the editor's validator reads. Every `pattern` (and `patternProperties` key) that is not linear by construction is
// removed from that copy first: the validator runs it in the browser, where a backtracking regex cannot be interrupted (`safe-pattern.ts`).
// The entity and the emitted AsyncAPI keep the pattern; the editor only loses an advisory warning.
//
// The pin comes from the client, so ownership is checked first: the entity (and, for a version, that version OF that entity) must
// belong to the caller's tenant. Anything else — another tenant's entity, an unknown id, a version of some other entity — is the one
// NOT_FOUND, naming only the id the caller sent, so a foreign entity's name and existence never leak.
import { entityReader } from "@/lib/access/entity-reader";
import { downConvertToDraft07 } from "@/lib/event-specs/json-schema-downconvert";
import type { JsonObject } from "@/lib/event-specs/types";
import { isJsonObject } from "@/lib/events/inputs";
import { sanitizeSchemaPatterns } from "@/lib/events/safe-pattern";
import type { EntityPin } from "@/lib/events/types";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { getSharedArtifactRenderer, type ArtifactRenderer, type ArtifactSubject } from "./artifact-renderer";
import { guardRead, requireId } from "./service-guards";

/** What reaches the browser is capped: a schema of this size is serialised once more into the editor and walked on every keystroke. */
export const MAX_PIN_SCHEMA_BYTES = 512 * 1024;

/** Shown for every render failure. The renderer's own text can hold raw `tsp` output and temp paths (see `event-snapshot.ts`, R67). */
export const PIN_SCHEMA_RENDER_FAILED = "The schema of this entity could not be generated";

export interface PinJsonSchemaDeps {
  renderer?: ArtifactRenderer;
}

const invalid = (message: string) => err({ code: "VALIDATION_ERROR", message });

/** `entityVersionId` absent or null is an unpinned pin; anything else must be a non-blank string. */
function parsePin(raw: unknown): Result<EntityPin> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid("pin must be an object");
  const { entityId, entityVersionId } = raw as Record<string, unknown>;
  const entity = requireId(entityId, "pin.entityId");
  if (!entity.success) return entity;
  if (entityVersionId === undefined || entityVersionId === null) return ok({ entityId: entity.data, entityVersionId: null });
  const version = requireId(entityVersionId, "pin.entityVersionId");
  return version.success ? ok({ entityId: entity.data, entityVersionId: version.data }) : version;
}

const subjectOf = (pin: EntityPin, tenantId: string): ArtifactSubject =>
  pin.entityVersionId ? { kind: "version", entityVersionId: pin.entityVersionId, tenantId } : { kind: "draft", entityId: pin.entityId, tenantId };

function renderFailed(where: string, detail: string): Result<never> {
  console.error(`[pin-json-schema] ${where}:`, detail);
  return err({ code: "ARTIFACT_RENDER_FAILED", message: PIN_SCHEMA_RENDER_FAILED });
}

export async function renderPinJsonSchema(
  ctx: ServiceContext,
  input: { tenantId: string; pin: EntityPin },
  deps: PinJsonSchemaDeps = {}
): Promise<Result<{ schema: Record<string, unknown> }>> {
  if (typeof input !== "object" || input === null) return invalid("Input must be an object");
  const tenantId = requireId(input.tenantId, "tenantId");
  if (!tenantId.success) return tenantId;
  const pin = parsePin(input.pin);
  if (!pin.success) return pin;

  const owned = await guardRead(async () => {
    const found = pin.data.entityVersionId
      ? await ctx.prisma.entityVersion.findFirst({
          where: { id: pin.data.entityVersionId, entityId: pin.data.entityId, entity: { tenantId: tenantId.data } },
          select: { id: true },
        })
      : await ctx.prisma.entity.findFirst({ where: { id: pin.data.entityId, tenantId: tenantId.data }, select: { id: true } });
    return found ? ok(undefined) : err({ code: "NOT_FOUND", message: `Entity "${pin.data.entityId}" not found` });
  });
  if (!owned.success) return owned;

  // The caller's read scope covers the whole closure, as in the preview: a schema reaching an entity the caller's roles do not cover renders nothing.
  let rendered: Awaited<ReturnType<ArtifactRenderer["render"]>>;
  try {
    rendered = await (deps.renderer ?? getSharedArtifactRenderer(ctx.prisma)).render(
      subjectOf(pin.data, tenantId.data),
      "json-schema",
      entityReader(ctx.assignments)
    );
  } catch (e: unknown) {
    return renderFailed("the renderer threw", e instanceof Error ? e.message : String(e));
  }
  if (!rendered.success) return renderFailed(`render failed (${rendered.error.code})`, rendered.error.message);
  const artifact = rendered.data.artifact;
  if (artifact.format !== "json-schema" || !isJsonObject(artifact.schema)) return renderFailed("not a JSON Schema artifact", `format ${artifact.format}`);

  let schema: JsonObject;
  let size: number;
  try {
    // sanitising can only shrink the schema, so the cap below is on what is really sent
    schema = sanitizeSchemaPatterns(downConvertToDraft07(artifact.schema).schema);
    size = Buffer.byteLength(JSON.stringify(schema), "utf8");
  } catch (e: unknown) {
    return renderFailed("the schema could not be converted", e instanceof Error ? e.message : String(e));
  }
  if (size > MAX_PIN_SCHEMA_BYTES) {
    return err({
      code: "TOO_LARGE",
      message: `The schema of this entity is too large to check examples against (${Math.ceil(size / 1024)} KB; the limit is ${MAX_PIN_SCHEMA_BYTES / 1024} KB)`,
    });
  }
  return ok({ schema });
}
