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
import { compileTypeSpecDocument, TypeSpecCompileError } from "@/lib/compiler/typespec-compiler";
import { checkImportSize, withCompileTimeout } from "@/lib/compiler/import-limits";
import { TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import {
  mapDocumentToImportResult,
  isEmptyTypeSpecDocument,
  type TypeSpecImportResult,
} from "@/lib/importers/typespec.importer";
import { refusedImportFieldMessage } from "@/lib/typespec-sync/field-types";

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
    // A text with compile errors is not imported: its errors are the answer (an unresolved or misspelt type is not read as a type of its own).
    if (e instanceof TypeSpecCompileError) {
      return err({
        code: "PARSE_ERROR",
        message: e.message,
        suggestedFix:
          "Fix the errors in the TypeSpec and import it again. A name it uses must be declared in the TypeSpec itself: an entity of another import is not in its text.",
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

  const result = mapDocumentToImportResult(doc, content);
  // A field typed with something that is not a type of the app is refused, not stored (the Source save and the preview refuse the same types).
  const refused = refusedImportFieldMessage(result);
  if (refused !== null) {
    return err({
      code: "PARSE_ERROR",
      message: refused,
      suggestedFix: "Change the field's type in the TypeSpec to a standard type, an enum, a union or a model of the text, and import it again.",
    });
  }
  return ok(result);
}
