/**
 * TypeSpec (.tsp) Importer — parses TypeSpec model definitions into ParsedEntity.
 *
 * Uses the existing TypeSpec parser from src/lib/compiler/typespec-parser.ts
 * and maps ParsedTypeSpecModel to the import pipeline's ParsedEntity format.
 *
 * Handles:
 * - Single model and multi-model documents
 * - Model name and @doc description
 * - Model inheritance (extends) and spread (...)
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
 * - Default values
 * - Standalone enums, custom scalars, unions, aliases
 * - Operations and interfaces
 * - Namespace declarations
 *
 * All fields have confidence "high" since TypeSpec is an exact schema language.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ParsedFieldConstraint } from "./types";
import { parseTypeSpec, parseTypeSpecDocument } from "@/lib/compiler/typespec-parser";
import type {
  ParsedTypeSpecField,
  ParsedTypeSpecDecorators,
  ParsedTypeSpecDocument,
} from "@/lib/compiler/typespec-parser";

// ---------------------------------------------------------------------------
// Multi-model import result
// ---------------------------------------------------------------------------

export interface TypeSpecImportResult {
  entities: ParsedEntity[];
  sharedEnums: Array<{ name: string; values: string[]; doc?: string }>;
  customScalars: Array<{ name: string; baseType: string; doc?: string }>;
  unions: Array<{ name: string; memberTypes: string[]; doc?: string }>;
  aliases: Array<{ name: string; type: string }>;
  interfaces: Array<{
    name: string;
    doc?: string;
    operations: Array<{
      name: string;
      doc?: string;
      httpMethod?: string;
      httpPath?: string;
      returnType: string;
      params: Array<{ name: string; type: string; location?: string; isOptional: boolean }>;
    }>;
  }>;
  namespace?: string;
  warnings: string[];
}

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
    // Decorators previously dropped — now preserved
    summary: tsField.decorators.summary,
    visibility: tsField.decorators.visibility,
    encode: tsField.decorators.encode,
    encodeSubType: tsField.decorators.encodeSubType,
    minValueExclusive: tsField.decorators.minValueExclusive,
    maxValueExclusive: tsField.decorators.maxValueExclusive,
    extensions: tsField.decorators.extensions,
    secret: tsField.decorators.secret || undefined,
    discriminator: tsField.decorators.discriminator,
  };

  return field;
}

// ---------------------------------------------------------------------------
// Public API — single entity (backwards compatible)
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

// ---------------------------------------------------------------------------
// Public API — full document import (multi-model)
// ---------------------------------------------------------------------------

export function parseTypeSpecFullDocument(content: string): Result<TypeSpecImportResult> {
  if (!content || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty TypeSpec content",
      suggestedFix: "Provide TypeSpec content with at least one model, enum, or operation.",
    });
  }

  const doc = parseTypeSpecDocument(content);
  const warnings: string[] = [];

  // If nothing was parsed at all
  if (
    doc.models.length === 0 &&
    doc.enums.length === 0 &&
    doc.scalars.length === 0 &&
    doc.unions.length === 0 &&
    doc.interfaces.length === 0 &&
    doc.operations.length === 0
  ) {
    return err({
      code: "PARSE_ERROR",
      message: "No TypeSpec constructs found in the document",
      suggestedFix:
        "Ensure the content contains TypeSpec constructs like model, enum, scalar, union, interface, or op.",
    });
  }

  // Map models to entities
  const entities: ParsedEntity[] = doc.models.map((model) => ({
    name: model.name,
    description: model.doc,
    fields: model.fields.map(mapField),
    sourceFormat: "typespec" as const,
    originalContent: content,
  }));

  // Note warnings for imports and usings
  for (const imp of doc.imports) {
    warnings.push(`Import "${imp}" noted — external imports are not resolved.`);
  }
  for (const using of doc.usings) {
    warnings.push(`Using "${using}" noted — library references are informational only.`);
  }

  // Map consts as warnings
  for (const c of doc.consts) {
    warnings.push(`Const "${c.name}" = ${c.value} noted — stored as metadata.`);
  }

  return ok({
    entities,
    sharedEnums: doc.enums.map((e) => ({
      name: e.name,
      values: e.values,
      doc: e.doc,
    })),
    customScalars: doc.scalars.map((s) => ({
      name: s.name,
      baseType: s.baseType,
      doc: s.doc,
    })),
    unions: doc.unions.map((u) => ({
      name: u.name,
      memberTypes: u.memberTypes,
      doc: u.doc,
    })),
    aliases: doc.aliases,
    interfaces: doc.interfaces.map((iface) => ({
      name: iface.name,
      doc: iface.doc,
      operations: iface.operations.map((op) => ({
        name: op.name,
        doc: op.doc,
        httpMethod: op.httpMethod,
        httpPath: op.httpPath,
        returnType: op.returnType,
        params: op.params.map((p) => ({
          name: p.name,
          type: p.type,
          location: p.location,
          isOptional: p.isOptional,
        })),
      })),
    })),
    namespace: doc.namespace,
    warnings,
  });
}
