"use server";

/**
 * The API tab's "Preview": the entity's OpenAPI 3 document as the `openapi3` target emits it (the same closure pipeline as
 * `generateSchemaAction`, draft mode, so the entity's API operations are its `paths`), WITHOUT storing a schema version. Read-only:
 * no audit row, no metadata write, no legacy-reference upgrade. Guarded like generation (`schema.generate` over the entity).
 */

import { prisma } from "@/lib/db";
import { entityReader } from "@/lib/access";
import { failureOf, guardSubject, unexpectedFailure } from "@/lib/action-context";
import { getActiveTenantId } from "@/lib/active-tenant";
import { loadReferenceClosure } from "@/lib/references/closure";

export type EntityOpenApiPreview =
  | {
      success: true;
      /** The entity's own OpenAPI document (YAML); "" when the emission failed. */
      yaml: string;
      /** The file it came from (`openapi.yaml`, `openapi.<Entity>.yaml`). */
      path: string;
      validationStatus: string;
      warnings: string[];
      errors: string[];
    }
  | { success?: undefined; error: string; code?: string };

const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 500;
const bounded = (messages: readonly string[]) =>
  messages
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, MAX_MESSAGES)
    .map((m) => (m.length > MAX_MESSAGE_LENGTH ? `${m.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : m));

export async function previewEntityOpenApiAction(entityId: string): Promise<EntityOpenApiPreview> {
  if (typeof entityId !== "string" || !entityId) return { error: "Entity id is required", code: "VALIDATION_ERROR" };
  try {
    const access = await guardSubject("schema.generate", { kind: "entity", id: entityId }, { label: "Entity" });
    if (!access.allowed) return { error: access.refusal.error, code: access.refusal.code };

    const { closureFailure, emitClosureTarget } = await import("@/lib/emission/closure-generation");
    const { filesForEntity } = await import("@/lib/typespec-official/closure-emit");
    const loaded = await loadReferenceClosure(prisma, await getActiveTenantId(), entityId, "draft", { reader: entityReader(access.principal.assignments) });
    if (!loaded.success) return { ...failureOf(closureFailure(loaded.error), "previewEntityOpenApiAction") };

    const result = await emitClosureTarget(loaded.data, "openapi3");
    const errors = bounded(result.errors.map((e) => e.message));
    const warnings = bounded(result.warnings);
    if (result.validationStatus === "INVALID") {
      return { success: true, yaml: "", path: "", validationStatus: "INVALID", warnings, errors: errors.length ? errors : ["The OpenAPI document could not be generated"] };
    }
    const own = filesForEntity(result.files ?? [], entityId);
    const file = own.find((f) => /\.ya?ml$/.test(f.path)) ?? own[0];
    if (!file) {
      return { success: true, yaml: "", path: "", validationStatus: "INVALID", warnings, errors: ["The emitter wrote no OpenAPI document for this entity"] };
    }
    return { success: true, yaml: file.content, path: file.path, validationStatus: result.validationStatus, warnings, errors };
  } catch (e: unknown) {
    return { ...unexpectedFailure("previewEntityOpenApiAction", e) };
  }
}
