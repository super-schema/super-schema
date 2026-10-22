/**
 * Implementation behind `importJsonSchemaFromUrlAction`. Deliberately NOT a "use server" module: it is not
 * callable from the browser, so it may take the injectable `deps` (fetchers, limits, extra git scopes) that tests use.
 * The exported server action passes none, which keeps every guard of the resolver on.
 */
import type { Result } from "@/types/result";
import { err, ok } from "@/types/result";
import { getActionContext, sanitizeActionError } from "@/lib/action-context";
import { withCompileTimeout } from "@/lib/compiler/import-limits";
import { DEFAULT_LIMITS } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl, type UrlImportDeps } from "@/lib/importers/jsonschema-url-import";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

const LABEL = "importJsonSchemaFromUrlAction";

export const MAX_SCHEMA_URL_LENGTH = 2048;
/** Resolver's overall timeout plus a margin for fetching the root and building the entities. */
export const URL_IMPORT_TIMEOUT_MS = DEFAULT_LIMITS.overallTimeoutMs + 30_000;

export function runJsonSchemaUrlImport(url: string, deps?: UrlImportDeps): Promise<Result<TypeSpecImportResult>> {
  return sanitizeActionError(runInner(url, deps), LABEL);
}

async function runInner(url: string, deps?: UrlImportDeps): Promise<Result<TypeSpecImportResult>> {
  const ctx = await getActionContext();
  if (!ctx) return err({ code: "UNAUTHORIZED", message: "Not authenticated" });

  if (typeof url !== "string" || !url.trim()) {
    return err({
      code: "VALIDATION_ERROR",
      message: "A schema URL is required",
      suggestedFix: "Provide an https URL of a JSON Schema document.",
    });
  }
  if (url.length > MAX_SCHEMA_URL_LENGTH) {
    return err({
      code: "VALIDATION_ERROR",
      message: `The schema URL is too long (the limit is ${MAX_SCHEMA_URL_LENGTH} characters)`,
      suggestedFix: "Use a shorter URL.",
    });
  }

  const imported = await withCompileTimeout(() => importJsonSchemaFromUrl(url.trim(), deps), URL_IMPORT_TIMEOUT_MS);
  if (!imported.success) return imported;
  if (!imported.data.success) return imported.data;
  return ok(toAssetImportResult(imported.data.data));
}
