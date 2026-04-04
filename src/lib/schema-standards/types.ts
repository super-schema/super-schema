/**
 * Schema Standard Reference Library — Type definitions
 * Story 11.2
 */

export interface StandardField {
  name: string;
  type: string;
  classification?: "PII" | "SENSITIVE" | "INTERNAL" | "PUBLIC";
  description?: string;
  qualityRules?: { rule: string; params?: Record<string, unknown> }[];
}

export interface StandardTemplate {
  standardName: string;
  entityName: string;
  description: string;
  fields: StandardField[];
  source: StandardSource;
  version: string;
}

export type StandardSource = "schema.org" | "financial" | "healthcare-fhir";
