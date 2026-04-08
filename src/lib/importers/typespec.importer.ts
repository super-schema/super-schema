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
  ParsedTypeSpecDecoratorDefinition,
  ParsedTypeSpecField,
  ParsedTypeSpecDecorators,
  ParsedTypeSpecDocument,
  ParsedTypeSpecModel,
  ParsedTypeSpecOperation,
} from "@/lib/compiler/typespec-parser";

// ---------------------------------------------------------------------------
// Multi-model import result
// ---------------------------------------------------------------------------

export interface TypeSpecImportModel extends ParsedEntity {
  extends?: string;
  referencedModelNames: string[];
  referencedByModelNames: string[];
  recommendedAsEntity: boolean;
}

export interface TypeSpecImportService {
  name: string;
  description?: string;
  basePath: string;
  source: "interface" | "standalone-operations";
  scope: "domain" | "entity";
  entityName?: string;
  operations: Array<{
    name: string;
    doc?: string;
    httpMethod?: string;
    httpPath?: string;
    returnType: string;
    params: Array<{ name: string; type: string; location?: string; isOptional: boolean }>;
  }>;
}

export interface TypeSpecImportResult {
  models: TypeSpecImportModel[];
  sharedEnums: Array<{ name: string; values: string[]; description?: string }>;
  customScalars: Array<{
    name: string;
    baseType: string;
    format?: string;
    pattern?: string;
    description?: string;
  }>;
  unions: Array<{ name: string; memberTypes: string[]; description?: string }>;
  aliases: Array<{ name: string; type: string }>;
  decoratorDefinitions: Array<{
    name: string;
    description?: string;
    signature: string;
    targetTypes: string[];
  }>;
  services: TypeSpecImportService[];
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

function collectReferencedModelNames(
  model: ParsedTypeSpecModel,
  knownModelNames: Set<string>
): string[] {
  const references = new Set<string>();

  for (const field of model.fields) {
    const candidates = [
      field.type,
      field.arrayElementType,
      ...field.type.split("|").map((part) => part.trim()),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (candidate !== model.name && knownModelNames.has(candidate)) {
        references.add(candidate);
      }
    }
  }

  if (model.extends && knownModelNames.has(model.extends)) {
    references.add(model.extends);
  }

  return [...references];
}

function isRecommendedEntityModel(
  model: ParsedTypeSpecModel,
  referencedModelNames: string[],
  referencedByModelNames: string[]
): boolean {
  if (model.fields.some((field) => field.isKey)) {
    return true;
  }

  const fieldReferenceCount = model.fields.reduce((count, field) => {
    if (field.type && referencedModelNames.includes(field.type)) {
      return count + 1;
    }
    if (field.arrayElementType && referencedModelNames.includes(field.arrayElementType)) {
      return count + 1;
    }
    return count;
  }, 0);

  return fieldReferenceCount > 0 && referencedByModelNames.length === 0;
}

function mapOperation(op: ParsedTypeSpecOperation): TypeSpecImportService["operations"][number] {
  return {
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
  };
}

function inferServiceBasePath(operations: ParsedTypeSpecOperation[]): string {
  const httpPaths = operations
    .map((operation) => operation.httpPath?.trim())
    .filter((path): path is string => !!path && path.startsWith("/"));

  if (httpPaths.length === 0) {
    return "/";
  }

  const splitPaths = httpPaths.map((path) => path.split("/").filter(Boolean));
  const commonSegments: string[] = [];
  const shortest = Math.min(...splitPaths.map((segments) => segments.length));

  for (let index = 0; index < shortest; index++) {
    const segment = splitPaths[0][index];
    if (!segment || segment.startsWith("{")) break;
    if (splitPaths.every((segments) => segments[index] === segment)) {
      commonSegments.push(segment);
      continue;
    }
    break;
  }

  return commonSegments.length > 0 ? `/${commonSegments.join("/")}` : "/";
}

function buildStandaloneOperationsServiceName(namespace: string | undefined): string {
  if (!namespace) {
    return "ImportedOperations";
  }

  const segments = namespace.split(".");
  return `${segments[segments.length - 1]}Operations`;
}

function mapServices(doc: ParsedTypeSpecDocument): TypeSpecImportService[] {
  const services: TypeSpecImportService[] = doc.interfaces.map((iface) => ({
    name: iface.name,
    description: iface.doc,
    basePath: inferServiceBasePath(iface.operations),
    source: "interface",
    scope: "domain",
    operations: iface.operations.map(mapOperation),
  }));

  if (doc.operations.length > 0) {
    services.push({
      name: buildStandaloneOperationsServiceName(doc.namespace),
      description: "Imported from standalone TypeSpec operations.",
      basePath: inferServiceBasePath(doc.operations),
      source: "standalone-operations",
      scope: "domain",
      operations: doc.operations.map(mapOperation),
    });
  }

  return services;
}

function mapDecoratorDefinitions(
  decorators: ParsedTypeSpecDecoratorDefinition[]
): TypeSpecImportResult["decoratorDefinitions"] {
  return decorators.map((decorator) => ({
    name: decorator.name,
    description: decorator.doc,
    signature: decorator.signature,
    targetTypes: decorator.targetTypes,
  }));
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
    doc.decorators.length === 0 &&
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

  const modelNameSet = new Set(doc.models.map((model) => model.name));
  const referencedByMap = new Map<string, Set<string>>();

  for (const model of doc.models) {
    const references = collectReferencedModelNames(model, modelNameSet);
    for (const reference of references) {
      const referencedBy = referencedByMap.get(reference) ?? new Set<string>();
      referencedBy.add(model.name);
      referencedByMap.set(reference, referencedBy);
    }
  }

  const models: TypeSpecImportModel[] = doc.models.map((model) => {
    const referencedModelNames = collectReferencedModelNames(model, modelNameSet);
    const referencedByModelNames = [...(referencedByMap.get(model.name) ?? new Set<string>())];

    return {
      name: model.name,
      description: model.doc,
      fields: model.fields.map(mapField),
      sourceFormat: "typespec" as const,
      originalContent: content,
      extends: model.extends,
      referencedModelNames,
      referencedByModelNames,
      recommendedAsEntity: isRecommendedEntityModel(
        model,
        referencedModelNames,
        referencedByModelNames
      ),
    };
  });

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

  const services = mapServices(doc);

  for (const service of services) {
    if (service.source === "standalone-operations") {
      warnings.push(
        `Standalone operations were grouped into service "${service.name}" for import review.`
      );
    }
  }

  return ok({
    models,
    sharedEnums: doc.enums.map((e) => ({
      name: e.name,
      values: e.values,
      description: e.doc,
    })),
    customScalars: doc.scalars.map((s) => ({
      name: s.name,
      baseType: s.baseType,
      format: s.format,
      pattern: s.pattern,
      description: s.doc,
    })),
    unions: doc.unions.map((u) => ({
      name: u.name,
      memberTypes: u.memberTypes,
      description: u.doc,
    })),
    aliases: doc.aliases,
    decoratorDefinitions: mapDecoratorDefinitions(doc.decorators),
    services,
    namespace: doc.namespace,
    warnings,
  });
}
