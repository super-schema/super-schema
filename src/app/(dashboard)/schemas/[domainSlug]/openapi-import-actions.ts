"use server";

/**
 * Server action for OpenAPI 3.x import.
 *
 * Reuses the official `@typespec/openapi3` converter to turn the OpenAPI
 * document into TypeSpec source, then feeds it through the exact same
 * TypeSpec compile pipeline used by `importTypeSpecDocumentAction` — so
 * entities, services, and operations all come out through code that is
 * already reviewed and tested. No OpenAPI-specific schema mapping is
 * reimplemented here.
 *
 *   OpenAPI YAML/JSON → parseYaml() → convertOpenAPI3Document() (official)
 *     → TypeSpec source → compileTypeSpecDocument() → mapDocumentToImportResult()
 */

import { parse as parseYaml } from "yaml";
import { convertOpenAPI3Document } from "@typespec/openapi3";
import type { Result } from "@/types/result";
import { ok, err } from "@/types/result";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import {
  mapDocumentToImportResult,
  isEmptyTypeSpecDocument,
  type TypeSpecImportResult,
} from "@/lib/importers/typespec.importer";

export async function importOpenApiDocumentAction(
  content: string
): Promise<Result<TypeSpecImportResult>> {
  if (!content || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty OpenAPI content",
      suggestedFix: "Provide an OpenAPI 3.x document (JSON or YAML).",
    });
  }

  let openApiDoc: unknown;
  try {
    openApiDoc = parseYaml(content);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "Failed to parse OpenAPI document",
      suggestedFix: "Ensure the content is valid YAML or JSON.",
    });
  }

  let tspSource: string;
  try {
    tspSource = await convertOpenAPI3Document(
      openApiDoc as Parameters<typeof convertOpenAPI3Document>[0]
    );
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "Failed to convert OpenAPI document",
      suggestedFix: "Check that the document is a valid OpenAPI 3.x specification.",
    });
  }

  let doc;
  try {
    doc = await compileTypeSpecDocument(tspSource);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: e instanceof Error ? e.message : "Failed to compile converted TypeSpec",
      suggestedFix: "The OpenAPI document converted to TypeSpec that failed to compile.",
    });
  }

  if (isEmptyTypeSpecDocument(doc)) {
    return err({
      code: "PARSE_ERROR",
      message: "No schemas or operations found in the OpenAPI document",
      suggestedFix: "Ensure the document has components.schemas and/or paths defined.",
    });
  }

  return ok(mapDocumentToImportResult(doc, tspSource));
}
