/**
 * AI Import Enhancement Service — Story 11.4
 * Enhances deterministic schema import with AI-powered type resolution
 * and confidence scoring. Layered on top of existing import parsers.
 * Falls back to deterministic results if AI is unavailable or fails.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  createAiClient,
  extractJsonFromResponse,
  normalizeType,
  clampConfidence,
  SUPPORTED_TYPES,
  CLASSIFICATION_OPTIONS,
} from "@/services/ai.service";
import type { DomainContext } from "@/services/ai.service";
import { resolveAiConfig } from "@/services/ai-config.service";
import type {
  ParsedField,
  EnhancedFieldMapping,
  EnhancedImportResult,
} from "@/types/schemas/ai-import";

// ── Name-based heuristic rules for type and classification ─────────────

const nameTypeHints: Record<string, string> = {
  amount: "decimal",
  price: "decimal",
  cost: "decimal",
  total: "decimal",
  balance: "decimal",
  salary: "decimal",
  revenue: "decimal",
  tax: "decimal",
  fee: "decimal",
  rate: "decimal",
  weight: "decimal",
  latitude: "decimal",
  longitude: "decimal",
  lat: "decimal",
  lng: "decimal",
  count: "integer",
  quantity: "integer",
  age: "integer",
  size: "integer",
  width: "integer",
  height: "integer",
  length: "integer",
  is_active: "boolean",
  is_deleted: "boolean",
  is_verified: "boolean",
  active: "boolean",
  enabled: "boolean",
  verified: "boolean",
  deleted: "boolean",
  created_at: "timestamp",
  updated_at: "timestamp",
  deleted_at: "timestamp",
  timestamp: "timestamp",
  date_created: "timestamp",
  date_modified: "timestamp",
  birth_date: "date",
  birthdate: "date",
  start_date: "date",
  end_date: "date",
  due_date: "date",
  expiry_date: "date",
};

const nameClassificationHints: Record<
  string,
  "PII" | "SENSITIVE" | "INTERNAL" | "PUBLIC"
> = {
  email: "PII",
  phone: "PII",
  telephone: "PII",
  address: "PII",
  name: "PII",
  first_name: "PII",
  last_name: "PII",
  given_name: "PII",
  family_name: "PII",
  birth_date: "PII",
  birthdate: "PII",
  ssn: "SENSITIVE",
  social_security: "SENSITIVE",
  password: "SENSITIVE",
  credit_card: "SENSITIVE",
  account_number: "SENSITIVE",
  routing_number: "SENSITIVE",
  tax_id: "SENSITIVE",
  salary: "SENSITIVE",
  balance: "SENSITIVE",
  amount: "SENSITIVE",
};

// ── Prompt Builder ─────────────────────────────────────────────────────

export function buildImportPrompt(
  sourceContent: string,
  parsedFields: ParsedField[],
  domainContext: DomainContext
): string {
  const fieldSummary = parsedFields
    .map((f) => `  - ${f.name}: ${f.type}`)
    .join("\n");

  return `You are a schema analysis assistant. Analyze the source schema and suggest optimal type mappings for the target type system.

## Target Type System
Available types: ${SUPPORTED_TYPES.join(", ")}

## Classification Taxonomy
Available classifications: ${CLASSIFICATION_OPTIONS.join(", ")}

## Domain Context
Domain: ${domainContext.domainName}
Existing entities: ${domainContext.existingEntityNames.length > 0 ? domainContext.existingEntityNames.join(", ") : "none"}

## Source Schema Content
${sourceContent.slice(0, 4000)}

## Deterministic Parser Results
${fieldSummary}

## Task
For each field, suggest:
1. The optimal target type (from the available types list)
2. A confidence score (0.0-1.0) for your type suggestion
3. A classification (PII, SENSITIVE, INTERNAL, PUBLIC) if applicable
4. Brief reasoning for your suggestion

Return a JSON array:
[
  {
    "name": "fieldName",
    "suggestedType": "target_type",
    "confidence": 0.0-1.0,
    "classification": "PII|SENSITIVE|INTERNAL|PUBLIC (or null)",
    "reasoning": "Brief explanation"
  }
]

Respond ONLY with valid JSON. No additional text.`;
}

// ── Merge Logic ────────────────────────────────────────────────────────

interface AiFieldSuggestion {
  name: string;
  suggestedType: string;
  confidence: number;
  classification?: string;
  reasoning?: string;
}

/**
 * Merge AI suggestions with deterministic parser output.
 */
export function mergeAiWithDeterministic(
  parsedFields: ParsedField[],
  aiSuggestions: AiFieldSuggestion[]
): EnhancedFieldMapping[] {
  const aiMap = new Map(
    aiSuggestions.map((s) => [s.name.toLowerCase(), s])
  );

  return parsedFields.map((field) => {
    const ai = aiMap.get(field.name.toLowerCase());
    const deterministicType = normalizeType(field.type);
    const deterministicConfidence = field.confidence ?? 0.6;

    if (!ai) {
      // No AI suggestion: keep deterministic
      return {
        name: field.name,
        deterministicType,
        finalType: deterministicType,
        confidence: deterministicConfidence,
        source: "deterministic" as const,
      };
    }

    const aiType = normalizeType(ai.suggestedType);
    const aiConfidence = clampConfidence(ai.confidence);

    if (aiType === deterministicType) {
      // AI agrees: boost confidence
      return {
        name: field.name,
        deterministicType,
        aiSuggestedType: aiType,
        finalType: deterministicType,
        confidence: Math.max(deterministicConfidence, aiConfidence),
        classification: ai.classification as
          | "PII"
          | "SENSITIVE"
          | "INTERNAL"
          | "PUBLIC"
          | undefined,
        aiReasoning: ai.reasoning,
        source: "deterministic" as const,
      };
    }

    // AI disagrees: use AI type (usually more semantically accurate)
    return {
      name: field.name,
      deterministicType,
      aiSuggestedType: aiType,
      finalType: aiType,
      confidence: aiConfidence,
      classification: ai.classification as
        | "PII"
        | "SENSITIVE"
        | "INTERNAL"
        | "PUBLIC"
        | undefined,
      aiReasoning: ai.reasoning,
      source: "ai-enhanced" as const,
    };
  });
}

// ── Quality Score ──────────────────────────────────────────────────────

/**
 * Calculate an overall quality score from field confidence values.
 * Higher-confidence fields are weighted more heavily.
 */
export function calculateOverallQualityScore(
  fields: EnhancedFieldMapping[]
): number {
  if (fields.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const field of fields) {
    const weight =
      field.confidence > 0.8 ? 1.0 : field.confidence >= 0.5 ? 0.7 : 0.3;
    weightedSum += field.confidence * weight;
    totalWeight += weight;
  }

  return totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 100) / 100
    : 0;
}

// ── Rule-Based Enhancement (no AI) ─────────────────────────────────────

/**
 * Apply rule-based heuristics to improve type and classification mappings.
 * Used when AI is not configured, or as a baseline.
 */
export function applyRuleBasedEnhancement(
  parsedFields: ParsedField[]
): EnhancedFieldMapping[] {
  return parsedFields.map((field) => {
    const fieldLower = field.name.toLowerCase().replace(/[-\s]/g, "_");
    const deterministicType = normalizeType(field.type);

    // Check if name-based hint suggests a better type
    const hintType = nameTypeHints[fieldLower];
    const classification = nameClassificationHints[fieldLower];

    if (hintType && hintType !== deterministicType) {
      return {
        name: field.name,
        deterministicType,
        aiSuggestedType: hintType,
        finalType: hintType,
        confidence: 0.75,
        classification,
        aiReasoning: `Field name "${field.name}" commonly maps to type "${hintType}"`,
        source: "ai-enhanced" as const,
      };
    }

    return {
      name: field.name,
      deterministicType,
      finalType: deterministicType,
      confidence: field.confidence ?? 0.6,
      classification,
      source: "deterministic" as const,
    };
  });
}

// ── Main Service Function ──────────────────────────────────────────────

/**
 * Enhance import with AI-powered type resolution and confidence scoring.
 * Falls back to rule-based enhancement if AI is unavailable.
 */
export async function enhanceImportWithAi(
  parsedFields: ParsedField[],
  sourceContent: string,
  domainContext: DomainContext,
  options?: { withAiEnhancement?: boolean }
): Promise<Result<EnhancedImportResult>> {
  // One resolution of the configuration serves both the check and the client.
  const config = options?.withAiEnhancement !== false ? await resolveAiConfig() : null;

  if (!config) {
    // Fall back to rule-based enhancement
    const enhanced = applyRuleBasedEnhancement(parsedFields);
    const overallQualityScore = calculateOverallQualityScore(enhanced);
    return ok({ fields: enhanced, overallQualityScore });
  }

  // Try AI enhancement
  const client = createAiClient(config);
  if (!client) {
    const enhanced = applyRuleBasedEnhancement(parsedFields);
    const overallQualityScore = calculateOverallQualityScore(enhanced);
    return ok({ fields: enhanced, overallQualityScore });
  }

  const prompt = buildImportPrompt(sourceContent, parsedFields, domainContext);
  const result = await client.complete(prompt);

  if (!result.success) {
    // AI failed: fall back to rule-based
    const enhanced = applyRuleBasedEnhancement(parsedFields);
    const overallQualityScore = calculateOverallQualityScore(enhanced);
    return ok({ fields: enhanced, overallQualityScore });
  }

  try {
    const jsonStr = extractJsonFromResponse(result.data);
    const aiSuggestions: AiFieldSuggestion[] = JSON.parse(jsonStr);

    const enhanced = mergeAiWithDeterministic(parsedFields, aiSuggestions);
    const overallQualityScore = calculateOverallQualityScore(enhanced);

    return ok({ fields: enhanced, overallQualityScore });
  } catch {
    // Parse failed: fall back to rule-based
    const enhanced = applyRuleBasedEnhancement(parsedFields);
    const overallQualityScore = calculateOverallQualityScore(enhanced);
    return ok({ fields: enhanced, overallQualityScore });
  }
}
