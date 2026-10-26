/**
 * Implementation behind `importJsonSchemaFromUrlAction`. Deliberately NOT a "use server" module: it is not
 * callable from the browser, so it may take the injectable `deps` (fetchers, limits, extra git scopes) that tests use.
 * The exported server action passes none, which keeps every guard of the resolver on.
 */
import type { Result } from "@/types/result";
import { err, ok } from "@/types/result";
import { getPrincipal } from "@/lib/access/principal";
import { sanitizeActionError } from "@/lib/action-context";
import { withCompileTimeout } from "@/lib/compiler/import-limits";
import { ImportLimiter, urlImportLimiter } from "@/lib/importers/import-limiter";
import { DEFAULT_LIMITS } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl, type UrlImportDeps } from "@/lib/importers/jsonschema-url-import";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

const LABEL = "importJsonSchemaFromUrlAction";

export const MAX_SCHEMA_URL_LENGTH = 2048;
/** Resolver's overall timeout plus a margin for fetching the root and building the entities. */
export const URL_IMPORT_TIMEOUT_MS = DEFAULT_LIMITS.overallTimeoutMs + 30_000;

/** Test seam, like `deps`: the exported server action passes none, so the process-wide limiter always applies. */
export interface UrlImportOptions {
  limiter?: ImportLimiter;
}

export function runJsonSchemaUrlImport(url: string, deps?: UrlImportDeps, options?: UrlImportOptions): Promise<Result<TypeSpecImportResult>> {
  return sanitizeActionError(runInner(url, deps, options), LABEL);
}

async function runInner(url: string, deps?: UrlImportDeps, options?: UrlImportOptions): Promise<Result<TypeSpecImportResult>> {
  // The action in front of this core asked the policy (`import.run`) before calling it; the core only needs to know WHO is importing, for the per-user
  // admission window: the principal (by id; nobody for no session, a disabled user or a stale one).
  const principal = await getPrincipal();
  if (!principal) return err({ code: "UNAUTHORIZED", message: "Not authenticated" });

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

  // Admission control (see import-limiter.ts): a slot per running import and a per-user window. Taken after the cheap checks above, so a
  // malformed request costs the user nothing. The slot is released when the import itself ends, not when the action stops waiting for it
  // (a timeout abandons the import, it does not cancel it, and the next one must not start on top of it).
  const slot = (options?.limiter ?? urlImportLimiter).acquire(principal.userId);
  if (!slot.ok) {
    return err({
      code: slot.reason === "busy" ? "IMPORT_BUSY" : "RATE_LIMITED",
      message: slot.message,
      suggestedFix: `Try again in ${Math.ceil(slot.retryAfterMs / 1000)} seconds.`,
      details: { retryAfterMs: slot.retryAfterMs },
    });
  }
  const running = importJsonSchemaFromUrl(url.trim(), deps);
  void running.then(slot.release, slot.release);
  const imported = await withCompileTimeout(() => running, URL_IMPORT_TIMEOUT_MS);
  if (!imported.success) return imported;
  if (!imported.data.success) return imported.data;
  return ok(toAssetImportResult(imported.data.data));
}
