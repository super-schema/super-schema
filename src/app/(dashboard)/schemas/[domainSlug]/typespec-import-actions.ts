"use server";

/**
 * Server action for TypeSpec import using the real @typespec/compiler.
 *
 * The compiler is async + Node-only, so it runs here (server) and returns plain
 * serializable data. The client (ImportDialog / EntityCreationWizard) calls this
 * instead of parsing TypeSpec in the browser.
 *
 * It runs the compiler on caller-supplied text, so it is authenticated, AUTHORIZED (`import.run` over the DOMAIN the text is for, `domainId`;
 * `null` is the tenant itself, for an Enterprise entity), size-capped and time-bounded
 * (see `@/lib/compiler/import-limits`), and its failures never echo raw compiler / host text: a disallowed
 * import is reported as such (`@/lib/typespec/import-guard`), anything unexpected is logged here and the
 * caller gets the generic message.
 */

import type { Result } from "@/types/result";
import { ok, err } from "@/types/result";
import { authorizeActiveTenant, authorizeSubject, sanitizeActionError } from "@/lib/action-context";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { checkImportSize, withCompileTimeout } from "@/lib/compiler/import-limits";
import { TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import {
  mapDocumentToImportResult,
  isEmptyTypeSpecDocument,
  type TypeSpecImportResult,
} from "@/lib/importers/typespec.importer";

export async function importTypeSpecDocumentAction(
  content: string,
  /** The domain the text is imported for (judged `import.run` there); `null` for the tenant itself (an Enterprise entity). */
  domainId: string | null = null
): Promise<Result<TypeSpecImportResult>> {
  return sanitizeActionError(runTypeSpecImport(content, domainId), "importTypeSpecDocumentAction");
}

async function runTypeSpecImport(content: string, domainId: string | null): Promise<Result<TypeSpecImportResult>> {
  // Before the text is looked at, let alone compiled: nobody, a user with no right to import into that domain, and a domain of another
  // tenant are refused (the last two exactly like a missing domain).
  const access =
    domainId === null || domainId === undefined
      ? await authorizeActiveTenant("import.run")
      : await authorizeSubject("import.run", { kind: "domain", id: domainId }, { code: "NOT_FOUND", message: "Domain not found" });
  if (!access.success) return err(access.error);

  if (typeof content !== "string" || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty TypeSpec content",
      suggestedFix: "Provide TypeSpec content with at least one model, enum, or operation.",
    });
  }
  const size = checkImportSize(content, "TypeSpec document");
  if (!size.success) return size;

  let compiled;
  try {
    compiled = await withCompileTimeout(() => compileTypeSpecDocument(content));
  } catch (e) {
    if (e instanceof TypeSpecImportGuardError) {
      return err({
        code: e.code,
        message: e.message,
        suggestedFix: "Remove the import; only @typespec/* libraries can be imported.",
      });
    }
    throw e; // sanitizeActionError logs it and returns the generic message
  }
  if (!compiled.success) return compiled;
  const doc = compiled.data;

  if (isEmptyTypeSpecDocument(doc)) {
    return err({
      code: "PARSE_ERROR",
      message: "No TypeSpec constructs found in the document",
      suggestedFix:
        "Ensure the content contains TypeSpec constructs like model, enum, scalar, union, interface, or op.",
    });
  }

  return ok(mapDocumentToImportResult(doc, content));
}
