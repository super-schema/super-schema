"use server";

/**
 * Server action for importing a JSON Schema (and every file it `$ref`s) from a URL.
 *
 * Callable by any authenticated user with any URL, so it takes ONLY the URL: the resolver's guards (https only, SSRF
 * checks, same-organization git scope, size / file / time limits) are always on and cannot be loosened from the
 * browser. Tests drive the non-action core (`jsonschema-url-import-core.ts`), which accepts injected fakes.
 */

import type { Result } from "@/types/result";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import { runJsonSchemaUrlImport } from "./jsonschema-url-import-core";

export async function importJsonSchemaFromUrlAction(url: string): Promise<Result<TypeSpecImportResult>> {
  return runJsonSchemaUrlImport(url);
}
