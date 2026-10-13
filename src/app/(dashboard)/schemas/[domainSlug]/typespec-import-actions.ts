"use server";

/**
 * Server action for TypeSpec import using the real @typespec/compiler.
 *
 * The compiler is async + Node-only, so it runs here (server) and returns plain
 * serializable data. The client (ImportDialog / EntityCreationWizard) calls this
 * instead of parsing TypeSpec in the browser.
 */

import type { Result } from "@/types/result";
import { ok, err } from "@/types/result";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import {
  mapDocumentToImportResult,
  isEmptyTypeSpecDocument,
  type TypeSpecImportResult,
} from "@/lib/importers/typespec.importer";

export async function importTypeSpecDocumentAction(
  content: string
): Promise<Result<TypeSpecImportResult>> {
  if (!content || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty TypeSpec content",
      suggestedFix: "Provide TypeSpec content with at least one model, enum, or operation.",
    });
  }

  let doc;
  try {
    doc = await compileTypeSpecDocument(content);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "Failed to compile TypeSpec",
      suggestedFix: "Check the TypeSpec syntax and try again.",
    });
  }

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
