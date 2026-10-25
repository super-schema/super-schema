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
 *
 * Like the TypeSpec import it runs a converter and the compiler on caller-supplied text, so it is
 * authenticated, size-capped and time-bounded (`@/lib/compiler/import-limits`) and never echoes raw
 * converter / compiler / host text: each stage reports a fixed sentence, the original error is logged
 * server-side, and anything unexpected becomes the generic message (`sanitizeActionError`).
 */

import { YAMLParseError } from "yaml";
import { parseYamlBounded } from "@/lib/importers/safe-yaml";
import { convertOpenAPI3Document } from "@typespec/openapi3";
import type { Result } from "@/types/result";
import { ok, err } from "@/types/result";
import { getActionContext, sanitizeActionError } from "@/lib/action-context";
import { compileTypeSpecDocument } from "@/lib/compiler/typespec-compiler";
import { checkImportSize, withCompileTimeout } from "@/lib/compiler/import-limits";
import { TypeSpecImportGuardError } from "@/lib/typespec/import-guard";
import {
  mapDocumentToImportResult,
  isEmptyTypeSpecDocument,
  type TypeSpecImportResult,
} from "@/lib/importers/typespec.importer";

const LABEL = "importOpenApiDocumentAction";

export async function importOpenApiDocumentAction(
  content: string
): Promise<Result<TypeSpecImportResult>> {
  return sanitizeActionError(runOpenApiImport(content), LABEL);
}

/** Only the position of a YAML syntax error is shown; the parser's message quotes the caller's own text. */
function describeYamlError(e: unknown): string {
  const pos = e instanceof YAMLParseError ? e.linePos?.[0] : undefined;
  return pos ? `The OpenAPI document is not valid YAML or JSON (line ${pos.line}, column ${pos.col})` : "The OpenAPI document is not valid YAML or JSON";
}

async function runOpenApiImport(content: string): Promise<Result<TypeSpecImportResult>> {
  const ctx = await getActionContext();
  if (!ctx) return err({ code: "UNAUTHORIZED", message: "Not authenticated" });

  if (typeof content !== "string" || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty OpenAPI content",
      suggestedFix: "Provide an OpenAPI 3.x document (JSON or YAML).",
    });
  }
  const size = checkImportSize(content, "OpenAPI document");
  if (!size.success) return size;

  // Bounded parse: an alias fan-out (a small file naming a huge value many times) is refused before anything expands it.
  const parsed = parseYamlBounded(content);
  if (!parsed.ok && parsed.kind !== "syntax") {
    return err({
      code: "PARSE_ERROR",
      message: parsed.message.replace("The YAML document", "The OpenAPI document"),
      suggestedFix:
        parsed.kind === "size"
          ? "Convert the document to JSON (accepted up to 2 MB), or split it into smaller documents."
          : "Write the repeated parts out in full instead of using YAML aliases, or use $ref to components.",
    });
  }
  if (!parsed.ok) {
    console.error(`[${LABEL}] OpenAPI document did not parse`, parsed.error);
    return err({
      code: "PARSE_ERROR",
      message: describeYamlError(parsed.error),
      suggestedFix: "Ensure the content is valid YAML or JSON.",
    });
  }
  const openApiDoc: unknown = parsed.value;

  const converted = await withCompileTimeout(async () => {
    try {
      return await convertOpenAPI3Document(openApiDoc as Parameters<typeof convertOpenAPI3Document>[0]);
    } catch (e) {
      console.error(`[${LABEL}] OpenAPI conversion failed`, e);
      return null;
    }
  });
  if (!converted.success) return converted;
  if (converted.data === null) {
    return err({
      code: "PARSE_ERROR",
      message: "The OpenAPI document could not be converted to TypeSpec",
      suggestedFix: "Check that the document is a valid OpenAPI 3.x specification.",
    });
  }
  const tspSource = converted.data;
  const tspSize = checkImportSize(tspSource, "converted TypeSpec");
  if (!tspSize.success) return tspSize;

  let compiled;
  try {
    compiled = await withCompileTimeout(() => compileTypeSpecDocument(tspSource));
  } catch (e) {
    if (e instanceof TypeSpecImportGuardError) {
      return err({
        code: e.code,
        message: e.message,
        suggestedFix: "The OpenAPI document converted to TypeSpec that imports something other than a TypeSpec library.",
      });
    }
    throw e; // sanitizeActionError logs it and returns the generic message
  }
  if (!compiled.success) return compiled;
  const doc = compiled.data;

  if (isEmptyTypeSpecDocument(doc)) {
    return err({
      code: "PARSE_ERROR",
      message: "No schemas or operations found in the OpenAPI document",
      suggestedFix: "Ensure the document has components.schemas and/or paths defined.",
    });
  }

  return ok({ ...mapDocumentToImportResult(doc, tspSource), sourceFormat: "openapi" });
}
