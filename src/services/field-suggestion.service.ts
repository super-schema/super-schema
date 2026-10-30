/**
 * Field Suggestion Service — Story 11.3
 * Orchestrates field suggestions from multiple sources:
 * 1. Standards library (rule-based, highest confidence)
 * 2. AI service (LLM-based, variable confidence)
 * 3. Pattern matching (heuristic-based, moderate confidence)
 */

import { ok } from "@/types/result";
import type { Result } from "@/types/result";
import type { RankedFieldSuggestion } from "@/types/schemas/ai";
import type { FieldSuggestion } from "@/types/schemas/ai";
import { suggestFieldsFromStandard } from "@/services/standards.service";
import {
  isAiConfigured,
  generateFieldSuggestions as aiGenerateFieldSuggestions,
} from "@/services/ai.service";
import type { DomainContext } from "@/services/ai.service";

// ── Pattern-Based Suggestions ──────────────────────────────────────────

interface PatternRule {
  keywords: string[];
  fields: FieldSuggestion[];
}

const universalFields: FieldSuggestion[] = [
  {
    name: "id",
    type: "string",
    classification: "INTERNAL",
    description: "Primary identifier",
    confidence: 0.7,
  },
  {
    name: "createdAt",
    type: "timestamp",
    description: "Record creation timestamp",
    confidence: 0.7,
  },
  {
    name: "updatedAt",
    type: "timestamp",
    description: "Last modification timestamp",
    confidence: 0.7,
  },
];

const patternRules: PatternRule[] = [
  {
    keywords: ["user", "customer", "person", "member", "contact", "employee"],
    fields: [
      {
        name: "email",
        type: "string",
        classification: "PII",
        description: "Email address",
        confidence: 0.7,
      },
      {
        name: "firstName",
        type: "string",
        classification: "PII",
        description: "First/given name",
        confidence: 0.7,
      },
      {
        name: "lastName",
        type: "string",
        classification: "PII",
        description: "Last/family name",
        confidence: 0.7,
      },
      {
        name: "phone",
        type: "string",
        classification: "PII",
        description: "Phone number",
        confidence: 0.6,
      },
    ],
  },
  {
    keywords: ["order", "transaction", "payment", "purchase"],
    fields: [
      {
        name: "amount",
        type: "decimal",
        classification: "SENSITIVE",
        description: "Monetary amount",
        confidence: 0.7,
      },
      {
        name: "currency",
        type: "string",
        description: "ISO 4217 currency code",
        confidence: 0.7,
      },
      {
        name: "status",
        type: "enum",
        description: "Current status",
        confidence: 0.7,
      },
      {
        name: "date",
        type: "timestamp",
        description: "Transaction date/time",
        confidence: 0.6,
      },
    ],
  },
  {
    keywords: ["product", "item", "good", "merchandise"],
    fields: [
      {
        name: "name",
        type: "string",
        description: "Product name",
        confidence: 0.7,
      },
      {
        name: "description",
        type: "string",
        description: "Product description",
        confidence: 0.7,
      },
      {
        name: "price",
        type: "decimal",
        description: "Unit price",
        confidence: 0.7,
      },
      {
        name: "sku",
        type: "string",
        description: "Stock keeping unit",
        confidence: 0.6,
      },
    ],
  },
  {
    keywords: ["address", "location"],
    fields: [
      {
        name: "street",
        type: "string",
        classification: "PII",
        description: "Street address",
        confidence: 0.7,
      },
      {
        name: "city",
        type: "string",
        description: "City name",
        confidence: 0.7,
      },
      {
        name: "state",
        type: "string",
        description: "State or province",
        confidence: 0.7,
      },
      {
        name: "postalCode",
        type: "string",
        classification: "PII",
        description: "Postal/ZIP code",
        confidence: 0.7,
      },
      {
        name: "country",
        type: "string",
        description: "Country",
        confidence: 0.7,
      },
    ],
  },
];

/**
 * Get pattern-based field suggestions based on entity name heuristics.
 */
export function getPatternBasedSuggestions(
  entityName: string
): FieldSuggestion[] {
  const lower = entityName.toLowerCase();
  const results: FieldSuggestion[] = [...universalFields];

  for (const rule of patternRules) {
    const matches = rule.keywords.some(
      (kw) => lower.includes(kw) || lower === kw
    );
    if (matches) {
      results.push(...rule.fields);
    }
  }

  return results;
}

// ── Main Orchestrator ──────────────────────────────────────────────────

/**
 * Get field suggestions from all available sources, merged and ranked.
 */
export async function getFieldSuggestions(
  entityName: string,
  domainContext: DomainContext,
  description?: string,
  existingFieldNames: string[] = []
): Promise<Result<RankedFieldSuggestion[]>> {
  const existingLower = new Set(
    existingFieldNames.map((n) => n.toLowerCase())
  );
  const seen = new Map<string, RankedFieldSuggestion>();

  // ── Source 1: Standards library (confidence 0.9) ──
  const standardResult = suggestFieldsFromStandard(
    entityName,
    existingFieldNames
  );
  if (standardResult.success) {
    for (const field of standardResult.data) {
      const key = field.name.toLowerCase();
      if (!existingLower.has(key)) {
        seen.set(key, {
          name: field.name,
          type: field.type,
          classification: field.classification,
          description: field.description,
          confidence: 0.9,
          source: "standard",
          rank: 0,
        });
      }
    }
  }

  // ── Source 2: AI suggestions (if configured) ──
  if (await isAiConfigured()) {
    const aiResult = await aiGenerateFieldSuggestions(
      entityName,
      domainContext,
      description
    );
    if (aiResult.success) {
      for (const field of aiResult.data) {
        const key = field.name.toLowerCase();
        if (!existingLower.has(key)) {
          const existing = seen.get(key);
          // Keep higher confidence version
          if (!existing || existing.confidence < field.confidence) {
            seen.set(key, {
              name: field.name,
              type: field.type,
              classification: field.classification,
              description: field.description,
              confidence: field.confidence,
              source: existing ? existing.source : "ai",
              rank: 0,
            });
          }
        }
      }
    }
  }

  // ── Source 3: Pattern-based suggestions (confidence 0.5-0.7) ──
  const patternSuggestions = getPatternBasedSuggestions(entityName);
  for (const field of patternSuggestions) {
    const key = field.name.toLowerCase();
    if (!existingLower.has(key) && !seen.has(key)) {
      seen.set(key, {
        name: field.name,
        type: field.type,
        classification: field.classification,
        description: field.description,
        confidence: field.confidence,
        source: "pattern",
        rank: 0,
      });
    }
  }

  // ── Rank by confidence descending ──
  const ranked = Array.from(seen.values())
    .sort((a, b) => b.confidence - a.confidence)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  return ok(ranked);
}
