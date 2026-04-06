/**
 * TypeSpec (.tsp) Importer — parses TypeSpec model definitions into ParsedEntity.
 *
 * Uses the existing TypeSpec parser from src/lib/compiler/typespec-parser.ts
 * and maps ParsedTypeSpecModel to the import pipeline's ParsedEntity format.
 *
 * Handles:
 * - Model name and @doc description
 * - Field types (mapped via the parser's type system)
 * - Optional fields (isOptional -> nullable)
 * - @key decorator -> isKey
 * - @doc decorator -> description
 * - @format decorator -> format hint
 * - @secret decorator -> classification = "SENSITIVE"
 * - @tag("classification:XXX") -> classification
 * - @minLength, @maxLength, @minValue, @maxValue, @pattern -> constraints
 * - @deprecated -> deprecated flag
 * - Array types (e.g. string[])
 *
 * All fields have confidence "high" since TypeSpec is an exact schema language.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ParsedFieldConstraint } from "./types";
import { parseTypeSpec } from "@/lib/compiler/typespec-parser";
import type { ParsedTypeSpecField, ParsedTypeSpecDecorators } from "@/lib/compiler/typespec-parser";

// ---------------------------------------------------------------------------
// Extract classification from decorators
// ---------------------------------------------------------------------------

function extractClassification(decorators: ParsedTypeSpecDecorators): string | undefined {
  // @secret -> SENSITIVE
  if (decorators.secret) {
    return "SENSITIVE";
  }

  // @tag("classification:PII") -> PII
  if (decorators.tag) {
    const classMatch = decorators.tag.match(/^classification:(.+)$/);
    if (classMatch) {
      return classMatch[1];
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Extract validation constraints from decorators
// ---------------------------------------------------------------------------

function extractConstraints(decorators: ParsedTypeSpecDecorators): ParsedFieldConstraint[] {
  const constraints: ParsedFieldConstraint[] = [];

  if (decorators.minLength !== undefined) {
    constraints.push({ type: "minLength", value: decorators.minLength });
  }
  if (decorators.maxLength !== undefined) {
    constraints.push({ type: "maxLength", value: decorators.maxLength });
  }
  if (decorators.minValue !== undefined) {
    constraints.push({ type: "minValue", value: decorators.minValue });
  }
  if (decorators.maxValue !== undefined) {
    constraints.push({ type: "maxValue", value: decorators.maxValue });
  }
  if (decorators.pattern !== undefined) {
    constraints.push({ type: "pattern", value: decorators.pattern });
  }
  if (decorators.minItems !== undefined) {
    constraints.push({ type: "minItems", value: decorators.minItems });
  }
  if (decorators.maxItems !== undefined) {
    constraints.push({ type: "maxItems", value: decorators.maxItems });
  }

  return constraints;
}

// ---------------------------------------------------------------------------
// Map a single ParsedTypeSpecField to a ParsedField
// ---------------------------------------------------------------------------

function mapField(tsField: ParsedTypeSpecField): ParsedField {
  const classification = extractClassification(tsField.decorators);
  const constraints = extractConstraints(tsField.decorators);

  const field: ParsedField = {
    name: tsField.name,
    type: tsField.type,
    nullable: tsField.isOptional,
    confidence: "high",
    originalType: tsField.type,
    isKey: tsField.isKey || undefined,
    description: tsField.decorators.doc,
    format: tsField.decorators.format,
    classification,
    constraints: constraints.length > 0 ? constraints : undefined,
    deprecated: tsField.decorators.deprecated !== undefined ? true : undefined,
    deprecatedMessage: tsField.decorators.deprecated,
  };

  return field;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseTypeSpecSchema(content: string): Result<ParsedEntity> {
  if (!content || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty TypeSpec content",
      suggestedFix: "Provide a TypeSpec model definition.",
    });
  }

  const model = parseTypeSpec(content);

  if (!model) {
    return err({
      code: "PARSE_ERROR",
      message: "Could not parse TypeSpec model definition",
      suggestedFix:
        "Ensure the content contains a valid TypeSpec model block, e.g. model User { id: string; }",
    });
  }

  const fields: ParsedField[] = model.fields.map(mapField);

  return ok({
    name: model.name,
    description: model.doc,
    fields,
    sourceFormat: "typespec",
    originalContent: content,
  });
}
