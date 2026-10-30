/**
 * AI Service — Story 11.1: Natural Language Entity Creation
 * Story 11.3: AI-Assisted Field Suggestions from Domain Context
 *
 * Provides AI client abstraction with configurable local LLM backend.
 * Communicates ONLY with configured local/self-hosted LLM (Ollama/vLLM).
 * Zero external calls at runtime.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import {
  EntitySuggestionSchema,
  type EntitySuggestion,
  type FieldSuggestion,
} from "@/types/schemas/ai";
import { resolveAiConfig, type ResolvedAiConfig } from "@/services/ai-config.service";

// ── Types ──────────────────────────────────────────────────────────────

export interface AiOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AiClient {
  complete(prompt: string, options?: AiOptions): Promise<Result<string>>;
}

export interface DomainContext {
  domainName: string;
  existingEntityNames: string[];
}

// ── Supported Type System (shared with prompts) ────────────────────────

export const SUPPORTED_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "enum",
  "array",
  "map",
  "reference",
  "date",
  "timestamp",
] as const;

export const CLASSIFICATION_OPTIONS = [
  "PII",
  "SENSITIVE",
  "INTERNAL",
  "PUBLIC",
] as const;

// ── AI Client Implementations ──────────────────────────────────────────

/** The headers of a completion request: the bearer key only when one is configured (AI_API_KEY; a local server usually needs none). */
function requestHeaders(apiKey: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export class OllamaClient implements AiClient {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string | null = null
  ) {}

  async complete(prompt: string, options?: AiOptions): Promise<Result<string>> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: requestHeaders(this.apiKey),
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            temperature: options?.temperature ?? 0.3,
            num_predict: options?.maxTokens ?? 2048,
          },
        }),
      });

      if (!response.ok) {
        return err({
          code: "AI_REQUEST_FAILED",
          message: `Ollama request failed with status ${response.status}`,
          suggestedFix:
            "Check that the Ollama server is running and the model is available.",
        });
      }

      const data = (await response.json()) as { response?: string };
      return ok(data.response ?? "");
    } catch (e) {
      return err({
        code: "AI_CONNECTION_ERROR",
        message: `Failed to connect to Ollama: ${e instanceof Error ? e.message : String(e)}`,
        suggestedFix:
          "Ensure the Ollama server is running at the configured base URL (Admin > AI, or AI_BASE_URL).",
      });
    }
  }
}

export class VllmClient implements AiClient {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string | null = null
  ) {}

  async complete(prompt: string, options?: AiOptions): Promise<Result<string>> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/completions`, {
        method: "POST",
        headers: requestHeaders(this.apiKey),
        body: JSON.stringify({
          model: this.model,
          prompt,
          temperature: options?.temperature ?? 0.3,
          max_tokens: options?.maxTokens ?? 2048,
        }),
      });

      if (!response.ok) {
        return err({
          code: "AI_REQUEST_FAILED",
          message: `vLLM request failed with status ${response.status}`,
          suggestedFix:
            "Check that the vLLM server is running and the model is available.",
        });
      }

      const data = (await response.json()) as {
        choices?: { text?: string }[];
      };
      const text = data.choices?.[0]?.text ?? "";
      return ok(text);
    } catch (e) {
      return err({
        code: "AI_CONNECTION_ERROR",
        message: `Failed to connect to vLLM: ${e instanceof Error ? e.message : String(e)}`,
        suggestedFix:
          "Ensure the vLLM server is running at the configured base URL (Admin > AI, or AI_BASE_URL).",
      });
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────

/** The client for a resolved configuration (see `resolveAiConfig`), or null when there is none. Pure: it reads nothing from the environment. */
export function createAiClient(config: ResolvedAiConfig | null): AiClient | null {
  if (!config) {
    return null;
  }

  switch (config.provider) {
    case "ollama":
      return new OllamaClient(config.baseUrl, config.model, config.apiKey);
    case "vllm":
      return new VllmClient(config.baseUrl, config.model, config.apiKey);
    default:
      return null;
  }
}

// ── Configuration Check ────────────────────────────────────────────────

/** True when an AI provider is configured (stored in Admin > AI, or by the environment). */
export async function isAiConfigured(): Promise<boolean> {
  return (await resolveAiConfig()) !== null;
}

// ── Prompt Builders ────────────────────────────────────────────────────

export function buildEntityPrompt(
  description: string,
  domainContext: DomainContext
): string {
  return `You are a data modeling assistant. Generate entity schemas in JSON format.

## Type System
Available field types: ${SUPPORTED_TYPES.join(", ")}

## Classification Options
Available classifications: ${CLASSIFICATION_OPTIONS.join(", ")}

## Domain Context
Domain: ${domainContext.domainName}
Existing entities in this domain: ${domainContext.existingEntityNames.length > 0 ? domainContext.existingEntityNames.join(", ") : "none"}

## Task
Based on the following description, generate an entity schema as JSON with the structure:
{
  "entityName": "PascalCaseName",
  "description": "Brief description",
  "fields": [
    {
      "name": "fieldName",
      "type": "one of the available types",
      "classification": "one of the available classifications (optional)",
      "description": "Brief field description",
      "confidence": 0.0 to 1.0
    }
  ]
}

## User Description
${description}

Respond ONLY with valid JSON. No additional text.`;
}

export function buildFieldSuggestionsPrompt(
  entityName: string,
  domainContext: DomainContext,
  description?: string
): string {
  return `You are a data modeling assistant. Suggest fields for an entity.

## Type System
Available field types: ${SUPPORTED_TYPES.join(", ")}

## Classification Options
Available classifications: ${CLASSIFICATION_OPTIONS.join(", ")}

## Domain Context
Domain: ${domainContext.domainName}
Existing entities: ${domainContext.existingEntityNames.length > 0 ? domainContext.existingEntityNames.join(", ") : "none"}

## Task
Suggest fields for an entity named "${entityName}"${description ? ` described as: "${description}"` : ""}.

Return a JSON array of field suggestions:
[
  {
    "name": "fieldName",
    "type": "one of the available types",
    "classification": "one of the available classifications (optional)",
    "description": "Brief field description",
    "confidence": 0.0 to 1.0
  }
]

Respond ONLY with valid JSON. No additional text.`;
}

// ── Response Parsers ───────────────────────────────────────────────────

/**
 * Extract JSON from LLM response text.
 * Handles: raw JSON, markdown code blocks (```json ... ```), leading/trailing text.
 */
export function extractJsonFromResponse(raw: string): string {
  // Try to extract from markdown code blocks first
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find JSON object or array boundaries
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  const arrayMatch = raw.match(/\[[\s\S]*\]/);

  if (objectMatch && arrayMatch) {
    // Return whichever starts first
    const objectIndex = raw.indexOf(objectMatch[0]);
    const arrayIndex = raw.indexOf(arrayMatch[0]);
    return objectIndex < arrayIndex
      ? objectMatch[0]
      : arrayMatch[0];
  }

  if (objectMatch) return objectMatch[0];
  if (arrayMatch) return arrayMatch[0];

  // Return as-is if no JSON boundaries found
  return raw.trim();
}

/**
 * Normalize a type string to a supported type.
 * Returns the supported type if recognized, otherwise falls back to "string".
 */
export function normalizeType(type: string): string {
  const normalized = type.toLowerCase().trim();

  // Direct match
  if ((SUPPORTED_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }

  // Common aliases
  const typeAliases: Record<string, string> = {
    str: "string",
    text: "string",
    varchar: "string",
    char: "string",
    int: "integer",
    int32: "integer",
    int64: "integer",
    bigint: "integer",
    smallint: "integer",
    number: "decimal",
    float: "decimal",
    double: "decimal",
    numeric: "decimal",
    money: "decimal",
    bool: "boolean",
    datetime: "timestamp",
    utcdatetime: "timestamp",
    plaindateTime: "timestamp",
    plaindate: "date",
    localdate: "date",
    object: "map",
    json: "map",
    ref: "reference",
    foreignkey: "reference",
    list: "array",
  };

  return typeAliases[normalized] ?? "string";
}

/**
 * Clamp a confidence score to the 0.0-1.0 range.
 */
export function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

/**
 * Parse an LLM response into an EntitySuggestion.
 */
export function parseEntitySuggestion(
  raw: string
): Result<EntitySuggestion> {
  try {
    const jsonStr = extractJsonFromResponse(raw);
    const parsed = JSON.parse(jsonStr);

    // Normalize types and clamp confidence
    if (parsed.fields && Array.isArray(parsed.fields)) {
      parsed.fields = parsed.fields.map(
        (f: Record<string, unknown>) => ({
          ...f,
          type: normalizeType(String(f.type ?? "string")),
          confidence: clampConfidence(f.confidence),
        })
      );
    }

    const validated = EntitySuggestionSchema.safeParse(parsed);
    if (!validated.success) {
      return err({
        code: "PARSE_ERROR",
        message: `Invalid entity suggestion structure: ${validated.error.issues.map((i) => i.message).join(", ")}`,
        suggestedFix:
          "The AI response did not match the expected format. Try again with a clearer description.",
      });
    }

    return ok(validated.data);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: `Failed to parse AI response: ${e instanceof Error ? e.message : String(e)}`,
      suggestedFix:
        "The AI response was not valid JSON. Try again with a clearer description.",
    });
  }
}

/**
 * Parse an LLM response into FieldSuggestion[].
 */
export function parseFieldSuggestions(
  raw: string
): Result<FieldSuggestion[]> {
  try {
    const jsonStr = extractJsonFromResponse(raw);
    const parsed = JSON.parse(jsonStr);

    const fields = Array.isArray(parsed) ? parsed : parsed.fields ?? [];

    const normalized = fields.map((f: Record<string, unknown>) => ({
      ...f,
      type: normalizeType(String(f.type ?? "string")),
      confidence: clampConfidence(f.confidence),
    }));

    return ok(normalized as FieldSuggestion[]);
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: `Failed to parse field suggestions: ${e instanceof Error ? e.message : String(e)}`,
      suggestedFix: "The AI response was not valid JSON.",
    });
  }
}

// ── Main Service Functions ─────────────────────────────────────────────

/**
 * Generate an entity schema from a natural language description.
 * Uses the configured local LLM backend.
 */
export async function generateEntityFromDescription(
  description: string,
  domainContext: DomainContext
): Promise<Result<EntitySuggestion>> {
  const client = createAiClient(await resolveAiConfig());
  if (!client) {
    return err({
      code: "AI_NOT_CONFIGURED",
      message:
        "AI assistance is not configured. Contact your administrator to set up a local LLM.",
      suggestedFix:
        "Set a provider in Admin > AI settings, or set the AI_PROVIDER and AI_BASE_URL environment variables to enable AI features.",
    });
  }

  const prompt = buildEntityPrompt(description, domainContext);
  const result = await client.complete(prompt);

  if (!result.success) {
    return result;
  }

  return parseEntitySuggestion(result.data);
}

/**
 * Generate field suggestions for an entity using AI.
 * Story 11.3 — called by field-suggestion.service.ts.
 */
export async function generateFieldSuggestions(
  entityName: string,
  domainContext: DomainContext,
  description?: string
): Promise<Result<FieldSuggestion[]>> {
  const client = createAiClient(await resolveAiConfig());
  if (!client) {
    return err({
      code: "AI_NOT_CONFIGURED",
      message: "AI is not configured for field suggestions.",
      suggestedFix:
        "Set a provider in Admin > AI settings, or set the AI_PROVIDER and AI_BASE_URL environment variables.",
    });
  }

  const prompt = buildFieldSuggestionsPrompt(
    entityName,
    domainContext,
    description
  );
  const result = await client.complete(prompt);

  if (!result.success) {
    return result;
  }

  return parseFieldSuggestions(result.data);
}
