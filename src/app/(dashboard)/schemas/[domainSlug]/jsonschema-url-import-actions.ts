"use server";

/**
 * Server action for importing a JSON Schema (and every file it `$ref`s) from a URL.
 *
 * Callable by a user who may import into the target domain (`import.run`), with any URL, so it takes ONLY the URL (and the domain it is
 * for): the resolver's guards (https only, SSRF checks, same-organization git scope, size / file / time limits) are always on and cannot
 * be loosened from the browser. The authorization comes BEFORE anything is fetched: a user who may not import costs the server no outbound
 * request. Tests drive the non-action core (`jsonschema-url-import-core.ts`), which accepts injected fakes.
 */

import type { Result } from "@/types/result";
import { err } from "@/types/result";
import { authorizeActiveTenant, authorizeSubject } from "@/lib/action-context";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import { runJsonSchemaUrlImport } from "./jsonschema-url-import-core";

export async function importJsonSchemaFromUrlAction(
  url: string,
  /** The domain the schema is imported for (judged `import.run` there); `null` for the tenant itself (an Enterprise entity). */
  domainId: string | null = null
): Promise<Result<TypeSpecImportResult>> {
  // A user who may not import into that domain (or a domain of another tenant, which reads like a missing one) is refused HERE, before the
  // core validates the URL, takes an import slot or makes any outbound request.
  const access =
    domainId === null || domainId === undefined
      ? await authorizeActiveTenant("import.run")
      : await authorizeSubject("import.run", { kind: "domain", id: domainId }, { code: "NOT_FOUND", message: "Domain not found" });
  if (!access.success) return err(access.error);
  return runJsonSchemaUrlImport(url);
}
