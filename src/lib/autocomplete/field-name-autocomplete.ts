import { commonFields, commonPatterns } from "@/lib/schema-standards";

export interface AutocompleteSuggestion {
  value: string;
  source: "standard" | "domain" | "pattern";
  sourceLabel?: string;
  suggestedType?: string;
  suggestedClassification?: string;
  description?: string;
}

export interface DomainField {
  name: string;
  type: string;
  entityName: string;
}

export function getFieldNameSuggestions(
  query: string,
  options: {
    existingFieldNames?: string[];
    domainFields?: DomainField[];
    maxResults?: number;
  } = {}
): AutocompleteSuggestion[] {
  const { existingFieldNames = [], domainFields = [], maxResults = 8 } = options;

  if (!query || query.length < 1) return [];

  const q = query.toLowerCase();
  const existing = new Set(existingFieldNames.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const results: AutocompleteSuggestion[] = [];

  function addIfNew(suggestion: AutocompleteSuggestion) {
    const key = suggestion.value.toLowerCase();
    if (!existing.has(key) && !seen.has(key)) {
      seen.add(key);
      results.push(suggestion);
    }
  }

  // Source 1: Domain standard suggestions (schema.org patterns)
  for (const field of commonFields) {
    if (field.name.toLowerCase().startsWith(q) || field.name.toLowerCase().includes(q)) {
      addIfNew({
        value: field.name,
        source: "standard",
        suggestedType: field.suggestedType,
        suggestedClassification: field.suggestedClassification,
        description: field.description,
      });
    }
  }

  // Source 2: Same-domain field suggestions
  for (const df of domainFields) {
    if (df.name.toLowerCase().startsWith(q) || df.name.toLowerCase().includes(q)) {
      addIfNew({
        value: df.name,
        source: "domain",
        sourceLabel: `(from ${df.entityName}.${df.name})`,
        suggestedType: df.type,
      });
    }
  }

  // Source 3: Common pattern suggestions
  for (const pattern of commonPatterns) {
    if (pattern.name.toLowerCase().startsWith(q) || pattern.name.toLowerCase().includes(q)) {
      addIfNew({
        value: pattern.name,
        source: "pattern",
        suggestedType: pattern.suggestedType,
        description: pattern.description,
      });
    }
  }

  // Rank: exact prefix match first, then contains match
  results.sort((a, b) => {
    const aPrefix = a.value.toLowerCase().startsWith(q) ? 0 : 1;
    const bPrefix = b.value.toLowerCase().startsWith(q) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    // Then by source priority: standard > domain > pattern
    const sourcePriority = { standard: 0, domain: 1, pattern: 2 };
    return sourcePriority[a.source] - sourcePriority[b.source];
  });

  return results.slice(0, maxResults);
}
