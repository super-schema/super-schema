/**
 * Standards Service — Story 11.2
 * Provides standard template lookup, comparison, and field suggestion logic.
 * All operations are read-only against bundled JSON data.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  getAllStandards,
  getStandardsBySource,
  findStandardByName,
  searchStandards,
} from "@/lib/schema-standards";
import type {
  StandardTemplate,
  StandardSource,
} from "@/lib/schema-standards/types";
import type { StandardField } from "@/lib/schema-standards/types";
import type { StandardReview } from "@/types/schemas/standards";

// ── Standard Templates ─────────────────────────────────────────────────

export function getStandardTemplates(filters?: {
  source?: StandardSource;
  query?: string;
}): Result<StandardTemplate[]> {
  let results: StandardTemplate[];

  if (filters?.source) {
    results = getStandardsBySource(filters.source);
  } else if (filters?.query) {
    results = searchStandards(filters.query);
  } else {
    results = getAllStandards();
  }

  // Apply both filters if both present
  if (filters?.source && filters?.query) {
    const q = filters.query.toLowerCase();
    results = results.filter(
      (t) =>
        t.entityName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }

  // Sort by source group, then entity name
  results.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.entityName.localeCompare(b.entityName);
  });

  return ok(results);
}

export function getStandardTemplate(
  standardName: string,
  entityName: string
): Result<StandardTemplate> {
  const all = getAllStandards();
  const template = all.find(
    (t) =>
      t.standardName.toLowerCase() === standardName.toLowerCase() &&
      t.entityName.toLowerCase() === entityName.toLowerCase()
  );

  if (!template) {
    return err({
      code: "NOT_FOUND",
      message: `Standard template "${standardName}/${entityName}" not found`,
      suggestedFix: "Check the standard name and entity name.",
    });
  }

  return ok(template);
}

// ── Review Against Standard ────────────────────────────────────────────

export function reviewAgainstStandard(
  entityFields: { name: string; type: string }[],
  standardName: string,
  entityName: string
): Result<StandardReview> {
  const templateResult = getStandardTemplate(standardName, entityName);
  if (!templateResult.success) {
    return templateResult;
  }

  const template = templateResult.data;
  const entityFieldMap = new Map(
    entityFields.map((f) => [f.name.toLowerCase(), f])
  );
  const standardFieldMap = new Map(
    template.fields.map((f) => [f.name.toLowerCase(), f])
  );

  const matching: { name: string; type: string; standardType: string }[] = [];
  const missing: StandardField[] = [];
  const extra: { name: string; type: string }[] = [];

  // Check standard fields against entity fields
  for (const sf of template.fields) {
    const entityField = entityFieldMap.get(sf.name.toLowerCase());
    if (entityField) {
      matching.push({
        name: entityField.name,
        type: entityField.type,
        standardType: sf.type,
      });
    } else {
      missing.push(sf);
    }
  }

  // Check entity fields not in standard
  for (const ef of entityFields) {
    if (!standardFieldMap.has(ef.name.toLowerCase())) {
      extra.push({ name: ef.name, type: ef.type });
    }
  }

  const totalStandardFields = template.fields.length;
  const matchPercentage =
    totalStandardFields > 0
      ? Math.round((matching.length / totalStandardFields) * 100)
      : 0;

  return ok({ matching, missing, extra, matchPercentage });
}

// ── Field Suggestions from Standards ───────────────────────────────────

/**
 * Suggest fields from a matching standard template, excluding fields
 * that already exist on the entity.
 */
export function suggestFieldsFromStandard(
  entityName: string,
  existingFieldNames: string[]
): Result<StandardField[]> {
  // Try exact match first
  let template = findStandardByName(entityName);

  // Try fuzzy match: remove trailing 's' for plurals
  if (!template && entityName.endsWith("s")) {
    template = findStandardByName(entityName.slice(0, -1));
  }

  // Try matching with common synonyms
  if (!template) {
    const synonyms: Record<string, string> = {
      customer: "Person",
      user: "Person",
      client: "Person",
      company: "Organization",
      business: "Organization",
      firm: "Organization",
      order: "Transaction",
      purchase: "Transaction",
      item: "Product",
      good: "Product",
    };
    const synonym = synonyms[entityName.toLowerCase()];
    if (synonym) {
      template = findStandardByName(synonym);
    }
  }

  if (!template) {
    return ok([]);
  }

  const existingLower = new Set(
    existingFieldNames.map((n) => n.toLowerCase())
  );

  const suggestions = template.fields.filter(
    (f) => !existingLower.has(f.name.toLowerCase())
  );

  return ok(suggestions);
}
