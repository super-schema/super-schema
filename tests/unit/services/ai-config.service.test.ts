// @vitest-environment node
/**
 * The AI provider configuration (src/services/ai-config.service.ts): the precedence of the stored override and the environment, the normalization of
 * base URLs, the secrecy of the API key, the platform administrator's gate, the audited save and clear, and the connection test (timeout, redirect,
 * no echo of the key or of the provider's answer). The database is replaced by a small in-memory row; `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assign } from "../../helpers/access-mocks";
import type { ServiceContext } from "@/types/service-context";

const h = vi.hoisted(() => ({
  row: null as null | { id: string; provider: string | null; baseUrl: string | null; model: string | null; updatedBy: string | null; updatedAt: Date },
  findUnique: vi.fn(),
  upsert: vi.fn(),
  userFindUnique: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    aiConfig: { findUnique: h.findUnique, upsert: h.upsert },
    user: { findUnique: h.userFindUnique },
    auditLog: { create: h.auditCreate },
  },
}));

import {
  getAiSettings,
  normalizeAiBaseUrl,
  ollamaHostToBaseUrl,
  resolveAiConfig,
  testAiConnection,
  updateAiSettings,
} from "@/services/ai-config.service";

const ENV_KEYS = ["AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY", "OLLAMA_HOST", "OPENAI_BASE_URL"] as const;
const SECRET = "sk-test-secret-value-123";
const TIMEOUT_MS = 3000;

const admin = (userId = "admin-1"): ServiceContext => ({ userId, userRole: "ADMIN", assignments: [assign.global()], prisma: {} as never });
const tenantAdmin = (): ServiceContext => ({ userId: "tadmin-1", userRole: "ADMIN", assignments: [assign.tenant("ADMIN", "tenant-1")], prisma: {} as never });
const nobody = (): ServiceContext => ({ userId: "nobody-1", userRole: "VIEWER", assignments: [], prisma: {} as never });

const storedRow = (fields: { provider?: string | null; baseUrl?: string | null; model?: string | null }) => ({
  id: "default",
  provider: fields.provider ?? null,
  baseUrl: fields.baseUrl ?? null,
  model: fields.model ?? null,
  updatedBy: "admin-1",
  updatedAt: new Date("2026-10-30T00:00:00Z"),
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const originalEnv = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  h.row = null;
  h.findUnique.mockReset().mockImplementation(async () => h.row);
  h.upsert.mockReset().mockImplementation(async (args: { update: Record<string, unknown> }) => {
    const current = h.row ?? { id: "default", provider: null, baseUrl: null, model: null, updatedBy: null, updatedAt: new Date() };
    h.row = { ...current, ...args.update, updatedAt: new Date() } as unknown as NonNullable<typeof h.row>;
    return h.row;
  });
  h.userFindUnique.mockReset().mockResolvedValue({ id: "admin-1" });
  h.auditCreate.mockReset().mockResolvedValue({});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Normalization (pure) ───────────────────────────────────────────────

describe("normalizeAiBaseUrl", () => {
  it("trims, drops trailing slashes and a trailing /v1, and keeps the port and any path prefix", () => {
    expect(normalizeAiBaseUrl("  http://localhost:11434  ")).toBe("http://localhost:11434");
    expect(normalizeAiBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434");
    expect(normalizeAiBaseUrl("http://gpu-box:8000/v1")).toBe("http://gpu-box:8000");
    expect(normalizeAiBaseUrl("http://gpu-box:8000/v1/")).toBe("http://gpu-box:8000");
    expect(normalizeAiBaseUrl("https://llm.internal/v1///")).toBe("https://llm.internal");
    expect(normalizeAiBaseUrl("https://gateway.internal/ollama/v1")).toBe("https://gateway.internal/ollama");
  });

  it("accepts http and https only", () => {
    for (const bad of ["ftp://host", "file:///etc/passwd", "javascript:alert(1)", "localhost:11434", "", "   ", "not a url"]) {
      expect(normalizeAiBaseUrl(bad), bad).toBeNull();
    }
  });

  it("refuses a query string, a fragment or credentials (they would break the paths the clients append)", () => {
    expect(normalizeAiBaseUrl("http://host:8000?x=1")).toBeNull();
    expect(normalizeAiBaseUrl("http://host:8000/#frag")).toBeNull();
    expect(normalizeAiBaseUrl("http://user:pass@host:8000")).toBeNull();
  });
});

describe("ollamaHostToBaseUrl (OLLAMA_HOST)", () => {
  it("takes host[:port] with no scheme and prefixes http://", () => {
    expect(ollamaHostToBaseUrl("localhost:11434")).toBe("http://localhost:11434");
    expect(ollamaHostToBaseUrl("ollama.internal")).toBe("http://ollama.internal");
  });

  it("takes a full URL as it is (normalized)", () => {
    expect(ollamaHostToBaseUrl("https://ollama.internal:11434/")).toBe("https://ollama.internal:11434");
  });

  it("maps the bind address 0.0.0.0 to 127.0.0.1, which is the one to connect to", () => {
    expect(ollamaHostToBaseUrl("0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaHostToBaseUrl("http://0.0.0.0:11434")).toBe("http://127.0.0.1:11434");
  });

  it("is null for an empty or unusable value", () => {
    expect(ollamaHostToBaseUrl("")).toBeNull();
    expect(ollamaHostToBaseUrl("ftp://ollama:11434")).toBeNull();
  });
});

// ── resolveAiConfig: precedence ────────────────────────────────────────

describe("resolveAiConfig (precedence: stored override > AI_* > legacy names)", () => {
  it("nothing configured: null, and the stored row is read once", async () => {
    expect(await resolveAiConfig()).toBeNull();
    expect(h.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "default" } }));
  });

  it("AI_PROVIDER with AI_BASE_URL is the environment's configuration (source env), normalized, model defaulting to llama3", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434/v1/";
    expect(await resolveAiConfig()).toEqual({ provider: "ollama", baseUrl: "http://localhost:11434", model: "llama3", apiKey: null, source: "env" });
  });

  it("AI_MODEL is the environment's model, and the provider name is case-insensitive", async () => {
    process.env.AI_PROVIDER = "VLLM";
    process.env.AI_BASE_URL = "http://gpu:8000";
    process.env.AI_MODEL = "  qwen2.5  ";
    expect(await resolveAiConfig()).toMatchObject({ provider: "vllm", model: "qwen2.5", source: "env" });
  });

  it("an unknown provider is no provider (null), whatever else is set", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_BASE_URL = "https://api.openai.com";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    expect(await resolveAiConfig()).toBeNull();
  });

  it("a provider has no fallback: AI_BASE_URL or a legacy name alone is not configured", async () => {
    process.env.AI_BASE_URL = "http://localhost:11434";
    process.env.OLLAMA_HOST = "localhost:11434";
    process.env.OPENAI_BASE_URL = "http://localhost:8000/v1";
    expect(await resolveAiConfig()).toBeNull();
  });

  it("OLLAMA_HOST is the base URL for ollama when AI_BASE_URL is unset (source legacy; 0.0.0.0 mapped)", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_HOST = "0.0.0.0:11434";
    expect(await resolveAiConfig()).toEqual({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3", apiKey: null, source: "legacy" });
  });

  it("OPENAI_BASE_URL is the base URL for vllm when AI_BASE_URL is unset (source legacy; /v1 dropped)", async () => {
    process.env.AI_PROVIDER = "vllm";
    process.env.OPENAI_BASE_URL = "http://vllm.internal:8000/v1";
    expect(await resolveAiConfig()).toEqual({ provider: "vllm", baseUrl: "http://vllm.internal:8000", model: "llama3", apiKey: null, source: "legacy" });
  });

  it("a legacy name is read only for its own provider (OLLAMA_HOST is not a vllm base URL)", async () => {
    process.env.AI_PROVIDER = "vllm";
    process.env.OLLAMA_HOST = "localhost:11434";
    expect(await resolveAiConfig()).toBeNull();
  });

  it("AI_BASE_URL wins over a legacy name when both are set", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://ai-base:11434";
    process.env.OLLAMA_HOST = "legacy-host:11434";
    expect(await resolveAiConfig()).toMatchObject({ baseUrl: "http://ai-base:11434", source: "env" });
  });

  it("a set AI_BASE_URL that is not usable is no configuration: the legacy name does not stand in for it", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "ftp://nope";
    process.env.OLLAMA_HOST = "localhost:11434";
    expect(await resolveAiConfig()).toBeNull();
  });

  it("the stored override wins ENTIRELY when it has a provider and a base URL (its model, else AI_MODEL, else llama3)", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    process.env.AI_MODEL = "env-model";
    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000/v1", model: null });
    expect(await resolveAiConfig()).toEqual({ provider: "vllm", baseUrl: "http://gpu:8000", model: "env-model", apiKey: null, source: "db" });

    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000", model: "stored-model" });
    expect(await resolveAiConfig()).toMatchObject({ provider: "vllm", baseUrl: "http://gpu:8000", model: "stored-model", source: "db" });

    delete process.env.AI_MODEL;
    h.row = storedRow({ provider: "ollama", baseUrl: "http://edge:11434", model: null });
    expect(await resolveAiConfig()).toMatchObject({ model: "llama3", source: "db" });
  });

  it("a stored row without a base URL (or without a provider) does not win: the environment decides", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    h.row = storedRow({ provider: "vllm", baseUrl: null, model: "x" });
    expect(await resolveAiConfig()).toMatchObject({ provider: "ollama", baseUrl: "http://localhost:11434", source: "env" });
    h.row = storedRow({ provider: null, baseUrl: "http://gpu:8000", model: "x" });
    expect(await resolveAiConfig()).toMatchObject({ provider: "ollama", source: "env" });
  });

  it("a stored row with an unusable base URL is ignored: the environment decides", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    h.row = storedRow({ provider: "vllm", baseUrl: "ftp://gpu", model: null });
    expect(await resolveAiConfig()).toMatchObject({ provider: "ollama", source: "env" });
  });

  it("the stored row with a base URL normalizes it when it is read (a trailing /v1 a database edit left)", async () => {
    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000/v1/", model: null });
    expect(await resolveAiConfig()).toMatchObject({ baseUrl: "http://gpu:8000", source: "db" });
  });

  it("when the stored row cannot be read, the environment decides and nothing throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    h.findUnique.mockRejectedValueOnce(new Error("connection refused"));
    expect(await resolveAiConfig()).toMatchObject({ provider: "ollama", source: "env" });
    expect(consoleError).toHaveBeenCalled();
  });

  it("AI_API_KEY applies whatever the source, and is never read from the stored row", async () => {
    process.env.AI_API_KEY = `  ${SECRET}  `;
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    expect(await resolveAiConfig()).toMatchObject({ apiKey: SECRET, source: "env" });

    delete process.env.AI_BASE_URL;
    process.env.OLLAMA_HOST = "localhost:11434";
    expect(await resolveAiConfig()).toMatchObject({ apiKey: SECRET, source: "legacy" });

    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000", model: null });
    expect(await resolveAiConfig()).toMatchObject({ apiKey: SECRET, source: "db" });
  });

  it("a blank AI_API_KEY is no key", async () => {
    process.env.AI_API_KEY = "   ";
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    expect(await resolveAiConfig()).toMatchObject({ apiKey: null });
  });
});

// ── getAiSettings ──────────────────────────────────────────────────────

describe("getAiSettings", () => {
  it("the view shows the stored override, the effective configuration and its source, and the environment hints", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434/v1";
    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen" });

    const result = await getAiSettings(admin());

    expect(result).toEqual({
      success: true,
      data: {
        stored: { provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen" },
        effective: { provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen", source: "db" },
        apiKeyConfigured: false,
        envHint: { providerEnv: "ollama", baseUrlEnv: "http://localhost:11434", modelEnv: null },
      },
    });
  });

  it("with nothing stored and nothing in the environment: nothing stored, nothing effective", async () => {
    const result = await getAiSettings(admin());
    expect(result).toEqual({
      success: true,
      data: {
        stored: { provider: null, baseUrl: null, model: null },
        effective: null,
        apiKeyConfigured: false,
        envHint: { providerEnv: null, baseUrlEnv: null, modelEnv: null },
      },
    });
  });

  it("the env hint for the base URL names the standard fallback when AI_BASE_URL is unset", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.OLLAMA_HOST = "0.0.0.0:11434";
    const result = await getAiSettings(admin());
    expect(result.success && result.data.envHint.baseUrlEnv).toBe("http://127.0.0.1:11434");
    expect(result.success && result.data.effective?.source).toBe("legacy");
  });

  it("NEVER carries the API key: only whether one is set", async () => {
    process.env.AI_API_KEY = SECRET;
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";

    const result = await getAiSettings(admin());

    expect(result.success && result.data.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("is refused (FORBIDDEN) to a tenant administrator, a viewer and a user with no role, and reads nothing", async () => {
    for (const ctx of [tenantAdmin(), nobody()]) {
      const result = await getAiSettings(ctx);
      expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    }
    expect(h.findUnique).not.toHaveBeenCalled();
  });

  it("a database that cannot be read is an error result for the page (never a throw)", async () => {
    h.findUnique.mockRejectedValueOnce(new Error("boom"));
    const result = await getAiSettings(admin());
    expect(result).toMatchObject({ success: false, error: { code: "DB_ERROR" } });
  });
});

// ── updateAiSettings ───────────────────────────────────────────────────

describe("updateAiSettings", () => {
  it("saves the override (provider, normalized base URL, model) with the acting user, and returns the new view", async () => {
    const result = await updateAiSettings({ provider: "vllm", baseUrl: "  http://gpu:8000/v1/ ", model: "qwen2.5" }, admin("admin-7"));

    expect(h.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: { id: "default", provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen2.5", updatedBy: "admin-7" },
      update: { provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen2.5", updatedBy: "admin-7" },
    });
    expect(result).toMatchObject({
      success: true,
      data: { stored: { provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen2.5" }, effective: { source: "db", baseUrl: "http://gpu:8000" } },
    });
  });

  it("writes an audit entry: a platform entry (no tenant), the stored fields before and after, never a key", async () => {
    process.env.AI_API_KEY = SECRET;
    h.row = storedRow({ provider: "ollama", baseUrl: "http://old:11434", model: null });

    await updateAiSettings({ provider: "vllm", baseUrl: "http://gpu:8000", model: null }, admin("admin-1"));

    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    const data = h.auditCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({
      action: "UPDATE",
      entityType: "AiConfig",
      entityId: "default",
      userId: "admin-1",
      beforeState: { provider: "ollama", baseUrl: "http://old:11434", model: null },
      afterState: { provider: "vllm", baseUrl: "http://gpu:8000", model: null },
    });
    expect(data.tenantId).toBeUndefined();
    expect(JSON.stringify(h.auditCreate.mock.calls)).not.toContain(SECRET);
  });

  it("clears the override when all three fields are empty (the environment decides again); empty strings are empty", async () => {
    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000", model: "x" });

    const result = await updateAiSettings({ provider: "", baseUrl: "  ", model: "" }, admin());

    expect(h.upsert.mock.calls[0][0].update).toMatchObject({ provider: null, baseUrl: null, model: null });
    expect(result).toMatchObject({ success: true, data: { stored: { provider: null, baseUrl: null, model: null } } });
  });

  it("the clear leaves the environment in charge", async () => {
    process.env.AI_PROVIDER = "ollama";
    process.env.AI_BASE_URL = "http://localhost:11434";
    h.row = storedRow({ provider: "vllm", baseUrl: "http://gpu:8000", model: null });
    const result = await updateAiSettings({ provider: null, baseUrl: null, model: null }, admin());
    expect(result).toMatchObject({ success: true, data: { effective: { provider: "ollama", source: "env" } } });
  });

  it("refuses an unknown provider, a non-http base URL, a base URL with a query, and an over-long model (VALIDATION_ERROR, nothing written)", async () => {
    const cases: unknown[] = [
      { provider: "openai", baseUrl: "http://x:1", model: null },
      { provider: "vllm", baseUrl: "ftp://gpu", model: null },
      { provider: "vllm", baseUrl: "http://gpu:8000?x=1", model: null },
      { provider: "vllm", baseUrl: "http://gpu:8000", model: "m".repeat(201) },
    ];
    for (const input of cases) {
      const result = await updateAiSettings(input, admin());
      expect(result, JSON.stringify(input)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it("is refused (FORBIDDEN) to a tenant administrator, and writes nothing", async () => {
    const result = await updateAiSettings({ provider: "ollama", baseUrl: "http://x:11434", model: null }, tenantAdmin());
    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it("a session whose user no longer exists is UNAUTHORIZED (the audit entry cannot name them) and nothing is saved past the audit", async () => {
    h.userFindUnique.mockResolvedValueOnce(null);
    const result = await updateAiSettings({ provider: "ollama", baseUrl: "http://x:11434", model: null }, admin("gone-1"));
    expect(result).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(h.auditCreate).not.toHaveBeenCalled();
  });

  it("a database failure is a DB_ERROR result", async () => {
    h.upsert.mockRejectedValueOnce(new Error("disk full"));
    const result = await updateAiSettings({ provider: "ollama", baseUrl: "http://x:11434", model: null }, admin());
    expect(result).toMatchObject({ success: false, error: { code: "DB_ERROR" } });
  });
});

// ── testAiConnection ───────────────────────────────────────────────────

describe("testAiConnection", () => {
  it("an ollama server: GETs /api/tags with no key header and no redirect, and says it is reachable with its model listed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [{ name: "llama3:latest" }, { name: "mistral:7b" }] }));

    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3" }, admin());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/tags");
    expect(init.redirect).toBe("manual");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result).toEqual({ success: true, data: { reachable: true, detail: 'Reachable: 2 models listed, including "llama3".' } });
  });

  it("a vLLM server: GETs /v1/models with the bearer key when AI_API_KEY is set, and says a model is not listed when it is not", async () => {
    process.env.AI_API_KEY = SECRET;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "other-model" }] }));

    const result = await testAiConnection({ provider: "vllm", baseUrl: "http://gpu:8000", model: "qwen" }, admin());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://gpu:8000/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(result).toEqual({ success: true, data: { reachable: true, detail: 'Reachable: 1 model listed. "qwen" is not among them.' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("with nothing submitted it tests the configuration in effect (the saved one)", async () => {
    h.row = storedRow({ provider: "vllm", baseUrl: "http://saved-gpu:8000", model: "saved" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "saved" }] }));

    const result = await testAiConnection({ provider: null, baseUrl: null, model: null }, admin());

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("http://saved-gpu:8000/v1/models");
    expect(result).toMatchObject({ success: true, data: { reachable: true } });
  });

  it("with nothing submitted and nothing in effect, it says so without a request", async () => {
    const result = await testAiConnection(undefined, admin());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, data: { reachable: false } });
  });

  it("the submitted values are tested, not the saved ones (the form is not saved yet)", async () => {
    h.row = storedRow({ provider: "ollama", baseUrl: "http://saved:11434", model: null });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { models: [] }));

    await testAiConnection({ provider: "ollama", baseUrl: "http://typed-in:11434/", model: null }, admin());

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("http://typed-in:11434/api/tags");
  });

  it("a redirect is a failure: redirects are not followed, and the answer says so", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://elsewhere/" } }));

    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434", model: null }, admin());

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect).toBe("manual");
    expect(result).toMatchObject({ success: true, data: { reachable: false } });
    expect((result as { data: { detail: string } }).data.detail).toMatch(/redirect \(HTTP 302\)/);
  });

  it("an error status is a failure with the status, and a hint about the key on 401 and 403, never the key", async () => {
    process.env.AI_API_KEY = SECRET;
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: `bad key ${SECRET}` }));

    const result = await testAiConnection({ provider: "vllm", baseUrl: "http://gpu:8000", model: null }, admin());

    expect(result).toEqual({ success: true, data: { reachable: false, detail: "The server answered HTTP 401. Check AI_API_KEY." } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("a server that does not answer within 3 seconds is unreachable (the request is aborted)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));

    const pending = testAiConnection({ provider: "ollama", baseUrl: "http://10.255.255.1:11434", model: null }, admin());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await pending).toEqual({ success: true, data: { reachable: false, detail: "No answer within 3 seconds." } });
  });

  it("a connection that fails (refused, DNS) is unreachable, with no detail from the error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED http://localhost:11434"));

    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434", model: null }, admin());

    expect(result).toEqual({
      success: true,
      data: { reachable: false, detail: "Could not connect to the server. Check the base URL and that the server is running." },
    });
  });

  it("an answer that is not the expected model list is unreachable, and the body is not echoed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { leaked: "private-model-xyz", models: "nope" }));

    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434", model: null }, admin());

    expect(result).toMatchObject({ success: true, data: { reachable: false } });
    expect(JSON.stringify(result)).not.toContain("private-model-xyz");
  });

  it("an answer that is not JSON is unreachable as the wrong kind of server, not as a failed connection", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>login page</html>", { status: 200 }));

    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434", model: null }, admin());

    expect(result).toMatchObject({ success: true, data: { reachable: false } });
    expect((result as { data: { detail: string } }).data.detail).toMatch(/not with the model list/);
    expect(JSON.stringify(result)).not.toContain("login page");
  });

  it("a half-filled form (a provider without a base URL) is refused: nothing is sent", async () => {
    const result = await testAiConnection({ provider: "vllm", baseUrl: null, model: null }, admin());
    expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused (FORBIDDEN) to a tenant administrator, and sends nothing", async () => {
    const result = await testAiConnection({ provider: "ollama", baseUrl: "http://localhost:11434", model: null }, tenantAdmin());
    expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
