import { z } from "zod";

// Panel 1: Identity & Semantics
export const IdentitySchema = z
  .object({
    key: z.boolean(),
    discriminator: z.boolean(),
    secret: z.boolean(),
    format: z.string().nullable(),
    optional: z.boolean(),
    defaultValue: z.unknown().nullable(),
  })
  .partial();

// Panel 2: Validation & Constraints
export const ValidationConstraintsSchema = z
  .object({
    minValue: z.number().nullable(),
    maxValue: z.number().nullable(),
    minValueExclusive: z.number().nullable(),
    maxValueExclusive: z.number().nullable(),
    minLength: z.number().int().nullable(),
    maxLength: z.number().int().nullable(),
    pattern: z.string().nullable(),
    minItems: z.number().int().nullable(),
    maxItems: z.number().int().nullable(),
  })
  .partial();

// Panel 3: Wire Format & Encoding
export const WireFormatSchema = z
  .object({
    encode: z.string().nullable(),
    encodeSubType: z.string().nullable(),
    encodedNames: z.record(z.string(), z.string()),
    httpBinding: z
      .enum([
        "none",
        "header",
        "query",
        "path",
        "cookie",
        "body",
        "bodyRoot",
        "bodyIgnore",
        "statusCode",
      ])
      .nullable(),
    httpBindingName: z.string().nullable(),
  })
  .partial();

// Panel 4: Visibility & Lifecycle
export const VisibilitySchema = z
  .object({
    phases: z.array(
      z.enum(["Create", "Read", "Update", "Delete", "Query"])
    ),
    invisible: z.boolean(),
    removeVisibility: z.boolean(),
  })
  .partial();

// Panel 5: Documentation
export const DocumentationSchema = z
  .object({
    doc: z.string(),
    summary: z.string(),
    example: z.unknown().nullable(),
    deprecated: z.string().nullable(),
    externalDocsUrl: z.string().nullable(),
    externalDocsDescription: z.string().nullable(),
  })
  .partial();

// Panel 6: Versioning
export const VersioningSchema = z
  .object({
    added: z.string().nullable(),
    removed: z.string().nullable(),
    renamedFrom: z
      .object({
        version: z.string(),
        oldName: z.string(),
      })
      .nullable(),
    madeOptional: z.string().nullable(),
    madeRequired: z.string().nullable(),
    typeChangedFrom: z
      .object({
        version: z.string(),
        oldType: z.string(),
      })
      .nullable(),
  })
  .partial();

// Panel 7: Protocol Extensions
export const ExtensionsSchema = z
  .object({
    openapi: z.record(z.string(), z.unknown()),
    xml: z
      .object({
        attribute: z.boolean(),
        element: z.boolean(),
        namespace: z.string().nullable(),
        namespacePrefix: z.string().nullable(),
        name: z.string().nullable(),
      })
      .partial(),
  })
  .partial();

// Panel 8: Governance
// Note: classification is stored on field.classification (single source of truth),
// NOT in the decorators JSONB. See GovernancePanel for read/write path.
export const GovernanceSchema = z
  .object({
    retention: z.string().nullable(),
    anonymization: z.string().nullable(),
    encryption: z.string().nullable(),
    qualityRules: z.array(
      z.object({
        type: z.string(),
        params: z.record(z.string(), z.unknown()),
      })
    ),
    lineage: z
      .object({
        source: z.string().nullable(),
        upstream: z.array(z.string()),
        downstream: z.array(z.string()),
      })
      .partial(),
    operationalHints: z
      .object({
        partition: z.boolean(),
        index: z.boolean(),
        cluster: z.boolean(),
      })
      .partial(),
    customAttributes: z.record(z.string(), z.string()),
  })
  .partial();

// Combined TypeSpec Decorator Schema
export const TypeSpecDecoratorSchema = z
  .object({
    identity: IdentitySchema,
    validation: ValidationConstraintsSchema,
    wireFormat: WireFormatSchema,
    visibility: VisibilitySchema,
    documentation: DocumentationSchema,
    versioning: VersioningSchema,
    extensions: ExtensionsSchema,
    governance: GovernanceSchema,
  })
  .partial();

export type TypeSpecDecorators = z.infer<typeof TypeSpecDecoratorSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type ValidationConstraints = z.infer<typeof ValidationConstraintsSchema>;
export type WireFormat = z.infer<typeof WireFormatSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type Documentation = z.infer<typeof DocumentationSchema>;
export type Versioning = z.infer<typeof VersioningSchema>;
export type Extensions = z.infer<typeof ExtensionsSchema>;
export type Governance = z.infer<typeof GovernanceSchema>;
