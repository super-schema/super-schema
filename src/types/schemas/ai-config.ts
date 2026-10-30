import { z } from "zod";

/** The AI providers the app speaks to: Ollama's own API, and any OpenAI-compatible server under /v1 (vLLM and the like). */
export const AI_PROVIDER_IDS = ["ollama", "vllm"] as const;

/** A field the admin left empty is the same as one that is not set: `null`. A missing key counts as empty too. */
const blankAsNull = (value: unknown) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value);

/** An http or https address (the service then normalizes it: trims it, drops trailing slashes and a trailing `/v1`). */
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "Base URL must be an http:// or https:// address");

/**
 * The AI provider settings an administrator saves (Admin > AI). Every field is nullable: all three empty clears the stored override, and the
 * environment decides again. The API key is not a field: it is read from AI_API_KEY and never stored or returned.
 */
export const UpdateAiSettingsInputSchema = z.object({
  provider: z.preprocess(blankAsNull, z.enum(AI_PROVIDER_IDS).nullable()),
  baseUrl: z.preprocess(blankAsNull, httpUrl.nullable()),
  model: z.preprocess(blankAsNull, z.string().trim().max(200).nullable()),
});

export type UpdateAiSettingsInput = z.infer<typeof UpdateAiSettingsInputSchema>;

/** The connection test takes the same fields (the values in the form, not yet saved). Leaving provider and base URL empty tests the saved configuration. */
export const TestAiConnectionInputSchema = UpdateAiSettingsInputSchema;

export type TestAiConnectionInput = z.infer<typeof TestAiConnectionInputSchema>;
