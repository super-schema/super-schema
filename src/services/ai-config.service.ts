/**
 * AI Configuration Service — where the AI provider, base URL and model come from, and the admin's page for them (Admin > AI).
 *
 * Resolution, in order (`resolveAiConfig`):
 *   1. the stored override (the `ai_config` row), when it names a provider AND a base URL: it wins entirely (its model, else AI_MODEL, else llama3);
 *   2. the environment: AI_PROVIDER with AI_BASE_URL;
 *   3. the standard names of the providers' own tools, when AI_BASE_URL is unset: OLLAMA_HOST (provider ollama) or OPENAI_BASE_URL (provider vllm).
 * A provider has no fallback: AI_PROVIDER or the stored override must name one. AI_API_KEY supplies the environment credential; a saved endpoint can have encrypted credentials.
 *
 * Credentials are encrypted at rest and never returned or logged; views carry only presence flags.
 */

import { openSecret, sealSecret, SecretBoxError } from "@/lib/crypto/secret-box";
import { prisma } from "@/lib/db";
import { ctxCan } from "@/lib/access";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  TestAiConnectionInputSchema,
  UpdateAiSettingsInputSchema,
  type AI_PROVIDER_IDS,
} from "@/types/schemas/ai-config";

// ── Types ──────────────────────────────────────────────────────────────

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export type AiConfigSource = "db" | "env" | "legacy" | "none";

/** Server-internal resolved configuration. Credentials go only to the selected endpoint. */
export interface ResolvedAiConfig {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  source: Exclude<AiConfigSource, "none">;
}

/** What the admin page shows. It never carries the key: `apiKeyConfigured` says only whether one is set. */
export interface AiSettingsView {
  /** The stored override as saved (null = not set). */
  stored: { provider: AiProviderId | null; baseUrl: string | null; model: string | null };
  /** What AI calls use right now, and where it comes from; null when no provider is configured at all. */
  effective: { provider: AiProviderId; baseUrl: string; model: string; source: AiConfigSource } | null;
  apiKeyConfigured: boolean;
  credentialsConfigured?: boolean;
  headersConfigured?: boolean;
  /** What the environment says, for the page's hints: AI_PROVIDER, the base URL it gives (AI_BASE_URL, or the OLLAMA_HOST / OPENAI_BASE_URL fallback), AI_MODEL. */
  envHint: { providerEnv: string | null; baseUrlEnv: string | null; modelEnv: string | null };
}

export interface AiConnectionResult {
  reachable: boolean;
  detail: string;
}

/** The stored override, as the service reads it: every field normalized, or null when it is not set (or was not valid). */
interface StoredAiConfig {
  credentials?: string | null;
  provider: AiProviderId | null;
  baseUrl: string | null;
  model: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────

/** The one row of the `ai_config` table. */
const CONFIG_ID = "default";

export const DEFAULT_AI_MODEL = "llama3";

/** How long a connection test waits for the server before it reports it unreachable. */
const TEST_TIMEOUT_MS = 3000;

// ── Normalization (pure) ───────────────────────────────────────────────

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * A base URL the clients can append their paths to: the server root, with trailing slashes and a trailing `/v1` removed (the OpenAI convention
 * includes `/v1`; the clients add it themselves). Only http and https, no query string or fragment, no credentials. Null when it is not usable.
 */
export function normalizeAiBaseUrl(raw: string, provider?: AiProviderId | null): string | null {
  const value = raw.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if ((provider !== "custom" && url.search !== "") || url.hash !== "" || url.username !== "" || url.password !== "") return null;
  if (provider === "custom" && [...url.searchParams.keys()].some((key) => /^(api[-_]?key|access[-_]?token|token|secret|password)$/i.test(key))) return null;
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  const path = provider === "custom" ? url.pathname : trimmedPath.replace(/\/v1$/i, "").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${provider === "custom" ? url.search : ""}`;
}

/**
 * OLLAMA_HOST, Ollama's own variable: `host[:port]` (no scheme) or a full URL. A bind address of 0.0.0.0 is not one to connect to, so it becomes
 * 127.0.0.1. Null when it is not usable.
 */
export function ollamaHostToBaseUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  return normalizeAiBaseUrl(url.toString());
}

function providerFrom(raw: string | null | undefined): AiProviderId | null {
  const value = raw?.trim().toLowerCase();
  return value === "ollama" || value === "vllm" || value === "custom" ? value : null;
}

function trimmedOrNull(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  return value ? value : null;
}

// ── Environment and stored row ─────────────────────────────────────────

interface EnvAiSettings {
  /** AI_PROVIDER when it names a provider we speak to. */
  provider: AiProviderId | null;
  /** AI_PROVIDER as written, for the page's hint. */
  providerEnv: string | null;
  /** AI_BASE_URL as written (not normalized yet); null when unset. */
  aiBaseUrl: string | null;
  /** OLLAMA_HOST and OPENAI_BASE_URL as written; null when unset. */
  ollamaHost: string | null;
  openaiBaseUrl: string | null;
  /** AI_MODEL; null when unset. */
  model: string | null;
  /** AI_API_KEY; null when unset. Never leaves the server. */
  apiKey: string | null;
}

function readEnv(): EnvAiSettings {
  return {
    provider: providerFrom(process.env.AI_PROVIDER),
    providerEnv: trimmedOrNull(process.env.AI_PROVIDER),
    aiBaseUrl: trimmedOrNull(process.env.AI_BASE_URL),
    ollamaHost: trimmedOrNull(process.env.OLLAMA_HOST),
    openaiBaseUrl: trimmedOrNull(process.env.OPENAI_BASE_URL),
    model: trimmedOrNull(process.env.AI_MODEL),
    apiKey: trimmedOrNull(process.env.AI_API_KEY),
  };
}

/** The base URL the standard name gives for `provider`, when AI_BASE_URL is unset. */
function legacyBaseUrl(env: EnvAiSettings, provider: AiProviderId): string | null {
  if (provider === "ollama") return env.ollamaHost ? ollamaHostToBaseUrl(env.ollamaHost) : null;
  return provider === "vllm" && env.openaiBaseUrl ? normalizeAiBaseUrl(env.openaiBaseUrl) : null;
}

/** The base URL the environment gives, as the page shows it (AI_BASE_URL, else the standard name for the environment's provider). */
function envBaseUrlHint(env: EnvAiSettings): string | null {
  if (env.aiBaseUrl) return normalizeAiBaseUrl(env.aiBaseUrl, env.provider);
  return env.provider ? legacyBaseUrl(env, env.provider) : null;
}

/** Reads the stored override. Throws when the database cannot be read (the callers decide what that means). */
async function readStoredConfig(): Promise<StoredAiConfig | null> {
  const row = await prisma.aiConfig.findUnique({
    where: { id: CONFIG_ID },
    select: { provider: true, baseUrl: true, model: true, credentials: true },
  });
  if (!row) return null;
  return {
    provider: providerFrom(row.provider),
    baseUrl: row.baseUrl ? normalizeAiBaseUrl(row.baseUrl, providerFrom(row.provider)) : null,
    ...(row.credentials ? { credentials: row.credentials } : {}),
    model: trimmedOrNull(row.model),
  };
}

interface AiCredentials { apiKey: string | null; headers: Record<string, string> }
function readCredentials(stored: StoredAiConfig | null): AiCredentials | null {
  if (!stored?.credentials) return null;
  return JSON.parse(openSecret(stored.credentials, "AiConfig.credentials")) as AiCredentials;
}

/** The resolution itself, over the values already read (pure, so the views and the calls cannot disagree). */
function resolveConfig(stored: StoredAiConfig | null, env: EnvAiSettings): ResolvedAiConfig | null {
  const apiKey = env.apiKey;

  // 1. The stored override: a provider and a base URL, both set, and it wins entirely.
  if (stored?.provider && stored.baseUrl) {
    const credentials = readCredentials(stored);
    if (stored.provider === "custom" && !stored.model) return null;
    return { provider: stored.provider, baseUrl: stored.baseUrl, model: stored.model ?? env.model ?? DEFAULT_AI_MODEL,
      apiKey: credentials ? credentials.apiKey : stored.provider === "custom" ? null : apiKey,
      ...(credentials ? { headers: credentials.headers } : {}), source: "db" };
  }

  // 2. The environment's provider and AI_BASE_URL. A set AI_BASE_URL that is not usable is an answer of its own: no fallback behind it.
  if (!env.provider || (env.provider === "custom" && !env.model)) return null;
  if (env.aiBaseUrl) {
    const baseUrl = normalizeAiBaseUrl(env.aiBaseUrl, env.provider);
    return baseUrl ? { provider: env.provider, baseUrl, model: env.model ?? DEFAULT_AI_MODEL, apiKey, source: "env" } : null;
  }

  // 3. The standard name of the provider's own tool.
  const baseUrl = legacyBaseUrl(env, env.provider);
  return baseUrl ? { provider: env.provider, baseUrl, model: env.model ?? DEFAULT_AI_MODEL, apiKey, source: "legacy" } : null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * The configuration AI calls use, or null when no provider is configured. Server-internal (no caller context): the stored override is read, and
 * when that read fails the environment decides (never throws).
 */
export async function resolveAiConfig(): Promise<ResolvedAiConfig | null> {
  const env = readEnv();
  let stored: StoredAiConfig | null = null;
  try {
    stored = await readStoredConfig();
  } catch (e) {
    console.error("[ai-config] could not read the stored AI settings; the environment decides", e);
  }
  try {
    return resolveConfig(stored, env);
  } catch {
    console.error("[ai-config] could not open the saved AI credentials");
    return null;
  }
}

function settingsView(stored: StoredAiConfig | null): AiSettingsView {
  const env = readEnv();
  const effective = resolveConfig(stored, env);
  return {
    stored: { provider: stored?.provider ?? null, baseUrl: stored?.baseUrl ?? null, model: stored?.model ?? null },
    effective: effective ? { provider: effective.provider, baseUrl: effective.baseUrl, model: effective.model, source: effective.source } : null,
    apiKeyConfigured: effective ? effective.apiKey !== null : env.apiKey !== null,
    ...(stored?.credentials ? { credentialsConfigured: true, headersConfigured: Object.keys(readCredentials(stored)?.headers ?? {}).length > 0 } : {}),
    envHint: { providerEnv: env.providerEnv, baseUrlEnv: envBaseUrlHint(env), modelEnv: env.model },
  };
}

function notPlatformAdmin(): Result<never> {
  return err({
    code: "FORBIDDEN",
    message: "Requires a platform administrator",
    suggestedFix: "Contact your administrator",
  });
}

/** The settings page's data: the stored override, what is in effect and where it comes from, and the environment hints. Platform administrators only. */
export async function getAiSettings(ctx: ServiceContext): Promise<Result<AiSettingsView>> {
  if (!ctxCan(ctx, "ai.manage")) return notPlatformAdmin();

  try {
    return ok(settingsView(await readStoredConfig()));
  } catch {
    return err({
      code: "DB_ERROR",
      message: "Could not read the AI settings",
      suggestedFix: "Try again. If it keeps failing, check the database connection.",
    });
  }
}

/**
 * Saves the AI provider settings (the override row; audited, without credentials). All three fields empty clears the override. Platform administrators only.
 */
export async function updateAiSettings(input: unknown, ctx: ServiceContext): Promise<Result<AiSettingsView>> {
  if (!ctxCan(ctx, "ai.manage")) return notPlatformAdmin();

  const parsed = UpdateAiSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the provider, base URL and model.",
    });
  }

  const baseUrl = parsed.data.baseUrl === null ? null : normalizeAiBaseUrl(parsed.data.baseUrl, parsed.data.provider);
  if (parsed.data.baseUrl !== null && baseUrl === null) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.data.provider === "custom" ? "Enter an HTTP(S) endpoint without URL credentials, fragments, or secret query parameters" : "Base URL must be an http:// or https:// address with no query string or credentials",
      suggestedFix: "Enter the server address, for example http://localhost:11434.",
    });
  }
  if (parsed.data.provider === "custom" && (!baseUrl || !parsed.data.model)) {
    return err({ code: "VALIDATION_ERROR", message: "Custom providers require a chat completions endpoint and model", suggestedFix: "Enter the full endpoint URL and model identifier." });
  }
  const next: StoredAiConfig = { provider: parsed.data.provider, baseUrl, model: parsed.data.model };

  try {
    const before = await readStoredConfig();
    const sameEndpoint = before?.provider === next.provider && before?.baseUrl === next.baseUrl;
    const hasNewCredentials = parsed.data.apiKey !== undefined || parsed.data.headers !== undefined;
    if (parsed.data.clearCredentials || !next.provider || !next.baseUrl || (!sameEndpoint && !hasNewCredentials)) {
      if (before?.credentials) next.credentials = null;
    } else if (hasNewCredentials) {
      const previous = sameEndpoint ? readCredentials(before) : null;
      const credentials: AiCredentials = {
        apiKey: parsed.data.apiKey !== undefined ? trimmedOrNull(parsed.data.apiKey) : previous?.apiKey ?? null,
        headers: parsed.data.headers ?? previous?.headers ?? {},
      };
      next.credentials = sealSecret(JSON.stringify(credentials), "AiConfig.credentials");
    } else if (before?.credentials) {
      next.credentials = before.credentials;
    }
    await withAudit({
      action: "UPDATE",
      entityType: "AiConfig",
      entityId: CONFIG_ID,
      userId: ctx.userId,
      // A platform setting: no tenant owns it.
      tenantId: null,
      beforeState: { provider: before?.provider ?? null, baseUrl: before?.baseUrl ?? null, model: before?.model ?? null },
      fn: async () => {
        await prisma.aiConfig.upsert({
          where: { id: CONFIG_ID },
          create: { id: CONFIG_ID, ...next, updatedBy: ctx.userId },
          update: { ...next, updatedBy: ctx.userId },
        });
        // The entry's state: the three stored fields and nothing else (never credentials).
        return { provider: next.provider, baseUrl: next.baseUrl, model: next.model };
      },
    });
    return ok(settingsView(next));
  } catch (e) {
    if (e instanceof SecretBoxError) return err({ code: "CONFIG_ERROR", message: e.message, suggestedFix: "Check the server secrets encryption configuration." });
    if (e instanceof AuditUserMissingError) {
      return err({ code: "UNAUTHORIZED", message: "Your session is stale. Sign out and sign in again, then retry.", suggestedFix: "Sign out and sign in again." });
    }
    return err({
      code: "DB_ERROR",
      message: "Could not save the AI settings",
      suggestedFix: "Try again. If it keeps failing, check the database connection.",
    });
  }
}

// ── Connection test ────────────────────────────────────────────────────

/** The list of models a provider's listing answers with: Ollama's `models[].name`, OpenAI-compatible `data[].id`. Null when the body has neither. */
function listedModels(provider: AiProviderId, body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  if (provider === "ollama") {
    const models = (body as { models?: unknown }).models;
    if (!Array.isArray(models)) return null;
    return models.map((m) => (m as { name?: unknown } | null)?.name).filter((name): name is string => typeof name === "string");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
}

/**
 * A model-list GET or custom chat POST to the provider's model listing, with a short timeout, no redirects and the key when one is set. The detail names the outcome: the
 * status, the model count, and whether the model is among them. Never the key, never the body.
 */
async function probeProvider(target: { provider: AiProviderId; baseUrl: string; model: string; apiKey: string | null; headers?: Record<string, string> }): Promise<AiConnectionResult> {
  const path = target.provider === "ollama" ? "/api/tags" : "/v1/models";
  const headers: Record<string, string> = Object.fromEntries(new Headers({
    ...(target.apiKey ? { Authorization: "Bearer " + target.apiKey } : {}),
  }).entries());
  for (const [name, value] of Object.entries(target.headers ?? {})) headers[name.toLowerCase()] = value;
  const controller = new AbortController();
  const timeoutMs = target.provider === "custom" ? 30_000 : TEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target.provider === "custom" ? target.baseUrl : target.baseUrl + path, {
      method: target.provider === "custom" ? "POST" : "GET",
      headers: target.provider === "custom" ? { ...headers, "Content-Type": "application/json" } : (target.apiKey ? { Authorization: "Bearer " + target.apiKey } : {}),
      ...(target.provider === "custom" ? { body: JSON.stringify({ model: target.model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 16, stream: false }) } : {}),
      redirect: "manual", signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      return { reachable: false, detail: `The server answered with a redirect (HTTP ${response.status}). Redirects are not followed: use the address it redirects to.` };
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? " Check the API key and integration headers." : "";
      return { reachable: false, detail: `The server answered HTTP ${response.status}.${hint}` };
    }

    const body = await response.json();
    if (target.provider === "custom") {
      const content = body?.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim()
        ? { reachable: true, detail: "The endpoint returned a chat completion for the selected model." }
        : { reachable: false, detail: "The endpoint did not return an OpenAI-compatible chat completion." };
    }
    const names = listedModels(target.provider, body);
    if (names === null) {
      return { reachable: false, detail: "The server answered, but not with the model list this provider type returns. Check the provider." };
    }
    const found = names.includes(target.model) || (target.provider === "ollama" && names.includes(`${target.model}:latest`));
    const count = `${names.length} model${names.length === 1 ? "" : "s"} listed`;
    return {
      reachable: true,
      detail: found ? `Reachable: ${count}, including "${target.model}".` : `Reachable: ${count}. "${target.model}" is not among them.`,
    };
  } catch (e) {
    if (controller.signal.aborted) {
      return { reachable: false, detail: `No answer within ${timeoutMs / 1000} seconds.` };
    }
    // A body that is not JSON (the server answered, but is not this provider's API).
    if (e instanceof SyntaxError) {
      return { reachable: false, detail: "The server answered, but not with the model list this provider type returns. Check the provider." };
    }
    return { reachable: false, detail: "Could not connect to the server. Check the base URL and that the server is running." };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tests a connection to the provider (Admin > AI). With the form's values (not yet saved) it tests those; with provider and base URL both empty it
 * tests the configuration in effect. Platform administrators only.
 */
export async function testAiConnection(input: unknown, ctx: ServiceContext): Promise<Result<AiConnectionResult>> {
  if (!ctxCan(ctx, "ai.manage")) return notPlatformAdmin();

  const parsed = TestAiConnectionInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the provider, base URL and model.",
    });
  }
  const { provider, baseUrl, model } = parsed.data;

  // Nothing submitted: test what is in effect.
  if (provider === null && baseUrl === null) {
    const effective = await resolveAiConfig();
    if (!effective) {
      return ok({ reachable: false, detail: "No AI provider is configured. Choose a provider and enter a base URL, then test again." });
    }
    return ok(await probeProvider(effective));
  }

  // Submitted values: both are needed to know what to call.
  if (provider === null || baseUrl === null) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Choose a provider and enter a base URL to test them, or leave both empty to test the saved configuration",
      suggestedFix: "Fill in both fields, or clear both.",
    });
  }
  const normalized = normalizeAiBaseUrl(baseUrl, provider);
  if (normalized === null) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.data.provider === "custom" ? "Enter an HTTP(S) endpoint without URL credentials, fragments, or secret query parameters" : "Base URL must be an http:// or https:// address with no query string or credentials",
      suggestedFix: "Enter the server address, for example http://localhost:11434.",
    });
  }

  if (provider === "custom" && !model) {
    return err({ code: "VALIDATION_ERROR", message: "Enter the model identifier to test a custom provider", suggestedFix: "Enter the model required by your integration." });
  }
  try {
    const env = readEnv();
    const stored = await readStoredConfig();
    const sameEndpoint = stored?.provider === provider && stored?.baseUrl === normalized;
    const saved = sameEndpoint && !parsed.data.clearCredentials ? readCredentials(stored) : null;
    return ok(await probeProvider({
      provider, baseUrl: normalized, model: model ?? env.model ?? DEFAULT_AI_MODEL,
      apiKey: parsed.data.clearCredentials ? null : parsed.data.apiKey !== undefined ? trimmedOrNull(parsed.data.apiKey) : saved ? saved.apiKey : provider === "custom" ? null : env.apiKey,
      headers: parsed.data.clearCredentials ? {} : parsed.data.headers ?? saved?.headers,
    }));
  } catch {
    return err({ code: "CONFIG_ERROR", message: "Could not read the saved AI credentials", suggestedFix: "Check the server secrets encryption configuration." });
  }
}
