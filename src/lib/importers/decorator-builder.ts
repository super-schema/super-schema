/**
 * Decorator Builder — converts ParsedField properties to the full
 * DecoratorSet JSON structure stored in field.decorators.
 *
 * This bridges the gap between the import parser output and the DB storage format.
 * Without this, parsed decorators (@format, @summary, @visibility, constraints, etc.)
 * are silently lost during import.
 *
 * Pure function — no side effects, no I/O.
 */

import type { ParsedField } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a complete decorators JSON object from a ParsedField.
 * Maps all parsed TypeSpec decorator data to the correct nested structure
 * matching DecoratorSchema / TypeSpecPanelDecorators.
 */
export function buildDecoratorsFromParsedField(
  field: ParsedField
): Record<string, unknown> {
  const decorators: Record<string, unknown> = {};
  const typespec: Record<string, unknown> = {};

  // --- typespec.identity ---
  const identity: Record<string, unknown> = {};
  if (field.format) identity.format = field.format;
  if (field.secret) identity.secret = true;
  if (field.isKey) identity.key = true;
  if (field.discriminator) identity.discriminator = true;
  if (Object.keys(identity).length > 0) typespec.identity = identity;

  // --- typespec.validation ---
  const validation: Record<string, unknown> = {};
  if (field.constraints) {
    for (const c of field.constraints) {
      validation[c.type] = c.value;
    }
  }
  if (field.minValueExclusive != null) validation.minValueExclusive = field.minValueExclusive;
  if (field.maxValueExclusive != null) validation.maxValueExclusive = field.maxValueExclusive;
  // Enum symbols ride in `pattern` ("A|B"): typespec-generator reads them from there
  // for enum fields (and never emits @pattern for an enum).
  if (field.type === "enum" && field.enumValues?.length && validation.pattern == null) {
    validation.pattern = field.enumValues.join("|");
  }
  if (Object.keys(validation).length > 0) typespec.validation = validation;

  // --- typespec.documentation ---
  const documentation: Record<string, unknown> = {};
  if (field.summary) documentation.summary = field.summary;
  if (field.deprecatedMessage) documentation.deprecated = field.deprecatedMessage;
  if (Object.keys(documentation).length > 0) typespec.documentation = documentation;

  // --- typespec.visibility ---
  if (field.visibility && field.visibility.length > 0) {
    typespec.visibility = { phases: field.visibility };
  }

  // --- typespec.wireFormat ---
  const wireFormat: Record<string, unknown> = {};
  if (field.encode) wireFormat.encode = field.encode;
  if (field.encodeSubType) wireFormat.encodeSubType = field.encodeSubType;
  if (Object.keys(wireFormat).length > 0) typespec.wireFormat = wireFormat;

  // --- typespec.extensions ---
  if (field.extensions && Object.keys(field.extensions).length > 0) {
    typespec.extensions = { openapi: field.extensions };
  }

  if (Object.keys(typespec).length > 0) decorators.typespec = typespec;

  // --- classification ---
  if (field.classification) {
    decorators.classification = { level: field.classification };
  }

  // --- complex type: reference target (top-level; read by compiler.service) ---
  if (field.referencedEntityName) {
    decorators.referencedEntityName = field.referencedEntityName;
  }
  if (field.arrayElementType) {
    decorators.arrayElementType = field.arrayElementType;
  }
  if (field.mapKeyType) decorators.mapKeyType = field.mapKeyType;
  if (field.mapValueType) decorators.mapValueType = field.mapValueType;
  if (field.enumName) decorators.enumName = field.enumName;
  // Union a `union` field (or an array of unions) refers to by name (read by compiler.service → generator).
  if (field.unionName) decorators.unionName = field.unionName;
  if (field.unionMembers?.length) decorators.unionMembers = field.unionMembers;
  // Symbols of an enum array element / map value (read by compiler.service → generator).
  if (field.type !== "enum" && field.enumValues?.length) decorators.enumValues = field.enumValues;

  // --- governance: format bindings (same keys the TypeSpec governance path stores) ---
  const governance: Record<string, unknown> = {};
  if (field.fieldNumber != null) governance.protobufFieldNumber = field.fieldNumber;
  if (field.governance?.protobufOneofGroup) {
    governance.protobufOneofGroup = field.governance.protobufOneofGroup;
  }
  if (field.governance?.avroFixedSize != null) governance.avroFixedSize = field.governance.avroFixedSize;
  if (Object.keys(governance).length > 0) decorators.governance = governance;

  // --- semantics ---
  if (field.description) {
    decorators.semantics = { description: field.description };
  }

  // --- evolution ---
  if (field.deprecated) {
    decorators.evolution = {
      deprecated: true,
      ...(field.deprecatedMessage && { since: field.deprecatedMessage }),
    };
  }

  return decorators;
}
