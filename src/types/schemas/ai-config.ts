import { z } from "zod";

/** Custom providers speak OpenAI-compatible Chat Completions at an exact endpoint. */
export const AI_PROVIDER_IDS = ["ollama", "vllm", "custom"] as const;
const blankAsNull = (value: unknown) => value === undefined || (typeof value === "string" && value.trim() === "") ? null : value;
const httpUrl = z.string().trim().max(2048).refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "Base URL must be an http:// or https:// address");
const headerName = z.string().regex(/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/i, "Invalid header name")
  .refine((name) => !["host", "content-length", "connection", "transfer-encoding", "cookie", "set-cookie", "content-type"].includes(name.toLowerCase()), "This header is managed by the application");
const headerValue = z.string().max(8192).refine((value) => !/[\r\n]/.test(value), "Header values must not contain line breaks");

export const UpdateAiSettingsInputSchema = z.object({
  provider: z.preprocess(blankAsNull, z.enum(AI_PROVIDER_IDS).nullable()),
  baseUrl: z.preprocess(blankAsNull, httpUrl.nullable()),
  model: z.preprocess(blankAsNull, z.string().trim().max(200).nullable()),
  apiKey: z.string().trim().max(8192).refine((value) => !/[\r\n]/.test(value), "API key must not contain line breaks").optional(),
  headers: z.record(headerName, headerValue).refine((headers) => Object.keys(headers).length <= 20, "Use at most 20 integration headers").optional(),
  clearCredentials: z.boolean().optional(),
});
export type UpdateAiSettingsInput = z.infer<typeof UpdateAiSettingsInputSchema>;
export const TestAiConnectionInputSchema = UpdateAiSettingsInputSchema;
export type TestAiConnectionInput = z.infer<typeof TestAiConnectionInputSchema>;
