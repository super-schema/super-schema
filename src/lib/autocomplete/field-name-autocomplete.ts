import { commonFields, commonPatterns } from "@/lib/schema-standards";
import type { DictionaryEntry } from "@/types/schemas/field-dictionary";

export interface AutocompleteSuggestion {
  value: string;
  source: "dictionary" | "standard" | "domain" | "pattern";
  sourceLabel?: string;
  suggestedType?: string;
  suggestedClassification?: string;
  description?: string;
  /** Dictionary suggestions only: the entry, and its default metadata attribute values (x-key to value). */
  entryId?: string;
  attributes?: Record<string, unknown>;
}

export interface DomainField {
  name: string;
  type: string;
  entityName: string;
}

export type DictionarySuggestionSource = Pick<
  DictionaryEntry,
  "id" | "name" | "aliases" | "type" | "description" | "classification" | "attributes"
>;

export function getFieldNameSuggestions(
  query: string,
  options: {
    existingFieldNames?: string[];
    domainFields?: DomainField[];
    /** The tenant's field dictionary: matched by name and aliases (case-insensitively) and ranked before every other source. */
    dictionary?: DictionarySuggestionSource[];
    maxResults?: number;
  } = {}
): AutocompleteSuggestion[] {
  const { existingFieldNames = [], domainFields = [], dictionary = [], maxResults = 8 } = options;

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

  // Source 0: the tenant dictionary. The canonical name is suggested; an alias match finds the entry.
  for (const entry of dictionary) {
    if (![entry.name, ...entry.aliases].some((n) => n.toLowerCase().includes(q))) continue;
    addIfNew({
      value: entry.name,
      source: "dictionary",
      entryId: entry.id,
      suggestedType: entry.type,
      suggestedClassification: entry.classification ?? undefined,
      description: entry.description,
      attributes: entry.attributes,
    });
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

  // Rank: dictionary first, then exact prefix match, then contains match
  results.sort((a, b) => {
    const aDict = a.source === "dictionary" ? 0 : 1;
    const bDict = b.source === "dictionary" ? 0 : 1;
    if (aDict !== bDict) return aDict - bDict;
    const aPrefix = a.value.toLowerCase().startsWith(q) ? 0 : 1;
    const bPrefix = b.value.toLowerCase().startsWith(q) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    // Then by source priority: standard > domain > pattern
    const sourcePriority = { dictionary: 0, standard: 1, domain: 2, pattern: 3 };
    return sourcePriority[a.source] - sourcePriority[b.source];
  });

  return results.slice(0, maxResults);
}
