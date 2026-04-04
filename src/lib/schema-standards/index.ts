/**
 * Schema Standards Library — Story 11.2
 * Bundled reference data for industry schema standards.
 * Fully offline-compatible, no runtime fetching.
 */

import commonFieldsData from "./common-fields.json";
import commonPatternsData from "./common-patterns.json";
import schemaOrgData from "./schema-org.json";
import financialData from "./financial.json";
import healthcareFhirData from "./healthcare-fhir.json";
import type {
  StandardTemplate,
  StandardSource,
  StandardField as StandardFieldType,
} from "./types";

// ── Legacy exports (pre-11.2) ──────────────────────────────────────────

export interface StandardField {
  name: string;
  suggestedType: string;
  suggestedClassification?: string;
  description: string;
}

export const commonFields: StandardField[] =
  commonFieldsData as StandardField[];
export const commonPatterns: StandardField[] =
  commonPatternsData as StandardField[];

// ── Standards Library API (Story 11.2) ─────────────────────────────────

const allStandards: StandardTemplate[] = [
  ...(schemaOrgData as StandardTemplate[]),
  ...(financialData as StandardTemplate[]),
  ...(healthcareFhirData as StandardTemplate[]),
];

/**
 * Get all bundled standard templates.
 */
export function getAllStandards(): StandardTemplate[] {
  return allStandards;
}

/**
 * Filter standard templates by source.
 */
export function getStandardsBySource(
  source: StandardSource
): StandardTemplate[] {
  return allStandards.filter((t) => t.source === source);
}

/**
 * Find a standard template by entity name (case-insensitive).
 */
export function findStandardByName(
  entityName: string
): StandardTemplate | undefined {
  const lower = entityName.toLowerCase();
  return allStandards.find((t) => t.entityName.toLowerCase() === lower);
}

/**
 * Search standards by query string across entity names and descriptions.
 * Simple substring matching for MVP.
 */
export function searchStandards(query: string): StandardTemplate[] {
  if (!query || query.trim().length === 0) return allStandards;

  const q = query.toLowerCase().trim();
  return allStandards.filter(
    (t) =>
      t.entityName.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
  );
}

// Re-export types
export type { StandardTemplate, StandardSource, StandardFieldType };
