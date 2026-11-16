"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { getAiSettingsAction, testAiConnectionAction, updateAiSettingsAction } from "@/app/(dashboard)/admin/actions";
import type { AiConfigSource, AiSettingsView } from "@/services/ai-config.service";

import { NativeSelect } from "@/components/ui/native-select";
const FIELD_CLASS = "w-full rounded-md border border-input bg-background px-space-3 py-space-2 text-body-small text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const SOURCE_LABEL: Record<AiConfigSource, string> = {
  db: "Saved on this page", env: "Server environment (AI_PROVIDER, AI_BASE_URL)",
  legacy: "Server environment (OLLAMA_HOST / OPENAI_BASE_URL)", none: "Not configured",
};
const PROVIDER_LABEL = { ollama: "Ollama", vllm: "vLLM / OpenAI-compatible", custom: "Custom provider" };
type Draft = { provider: string; baseUrl: string; model: string; apiKey: string; headers: string; clearCredentials: boolean };
const EMPTY: Draft = { provider: "", baseUrl: "", model: "", apiKey: "", headers: "", clearCredentials: false };
const toDraft = (view: AiSettingsView): Draft => ({
  ...EMPTY, provider: view.stored.provider ?? "", baseUrl: view.stored.baseUrl ?? "", model: view.stored.model ?? "",
});

function payload(draft: Draft) {
  let headers: Record<string, string> | undefined;
  if (draft.headers.trim()) {
    const parsed: unknown = JSON.parse(draft.headers);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string"))
      throw new Error("Integration headers must be a JSON object with string values.");
    headers = parsed as Record<string, string>;
  }
  return {
    provider: draft.provider, baseUrl: draft.baseUrl, model: draft.model,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    ...(headers ? { headers } : {}),
    ...(draft.clearCredentials ? { clearCredentials: true } : {}),
  };
}

/** Credentials are write-only: saved keys and header values never return to this component. */
export function AiSettingsForm() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ reachable: boolean; detail: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getAiSettingsAction();
      if ("error" in res) setError(res.error ?? "Could not load AI settings.");
      else { setView(res.data); setDraft(toDraft(res.data)); }
    } catch { setError("Could not load AI settings. Refresh this page to retry."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    // Fetch once on mount; state updates follow the awaited server response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function change(field: keyof Draft, value: string | boolean) {
    setDraft((current) => ({ ...current, [field]: value, ...(field === "provider" ? { apiKey: "", headers: "", clearCredentials: false } : {}) }));
    setSaved(false);
    setTest(null);
  }
  async function save(next: Draft) {
    setBusy("save"); setError(null); setSaved(false);
    try {
      const input = payload(next);
      const res = await updateAiSettingsAction(input);
      if ("error" in res) setError(res.error ?? "Could not save AI settings.");
      else { setView(res.data); setDraft(toDraft(res.data)); setSaved(true); setTest(null); }
    } catch { setError("Could not save. Check that integration headers are a JSON object with string values, then retry."); }
    finally { setBusy(null); }
  }
  async function runTest() {
    setBusy("test"); setError(null); setTest(null);
    try {
      const res = await testAiConnectionAction(payload(draft));
      if ("error" in res) setError(res.error ?? "Could not test the connection.");
      else setTest(res.data);
    } catch { setError("Could not test. Check that integration headers are a JSON object with string values, then retry."); }
    finally { setBusy(null); }
  }

  if (loading) return (
    <div className="flex items-center gap-space-2 py-space-6 text-body-small text-muted-foreground" role="status">
      <RefreshCw className="size-4 animate-spin" aria-hidden="true" /> Loading AI settings…
    </div>
  );
  const stored = view?.stored;
  const effective = view?.effective;
  const hasOverride = Boolean(stored && (stored.provider || stored.baseUrl || stored.model || view?.credentialsConfigured));
  const dirty = stored !== undefined && (draft.provider !== (stored.provider ?? "") || draft.baseUrl !== (stored.baseUrl ?? "") || draft.model !== (stored.model ?? "") || !!draft.apiKey.trim() || !!draft.headers.trim() || draft.clearCredentials);
  const custom = draft.provider === "custom";

  return (
    <div className="flex max-w-3xl flex-col gap-space-4" data-testid="ai-settings">
      {error && <div role="alert" data-testid="ai-settings-error" className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive">{error}</div>}
      <section aria-labelledby="ai-effective-title" data-testid="ai-settings-effective" className="flex flex-col gap-1 rounded-lg border border-border p-space-4">
        <h3 id="ai-effective-title" className="text-heading-4 text-foreground">In use now</h3>
        {effective ? <p className="break-words text-body-small text-foreground">
          <span data-testid="ai-settings-effective-provider">{PROVIDER_LABEL[effective.provider]}</span> at{" "}
          <code className="text-caption">{effective.baseUrl}</code>, model <code className="text-caption">{effective.model}</code>
        </p> : <p className="text-body-small text-muted-foreground">No AI provider is configured, so AI-assisted creation is off.</p>}
        <p className="text-caption text-muted-foreground" data-testid="ai-settings-source">Source: {SOURCE_LABEL[effective?.source ?? "none"]}</p>
      </section>
      <form onSubmit={(event) => { event.preventDefault(); void save(draft); }}>
        <fieldset disabled={busy !== null || !view} className="min-w-0">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="ai-provider">Provider</FieldLabel>
              <NativeSelect id="ai-provider" data-testid="ai-settings-provider" value={draft.provider} onChange={(e) => change("provider", e.target.value)}>
                <option value="">Not set (use the server environment)</option>
                <option value="ollama">Ollama</option>
                <option value="vllm">vLLM / OpenAI-compatible</option>
                <option value="custom">Custom provider (OpenAI-compatible chat)</option>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-base-url">{custom ? "Chat completions endpoint" : "Base URL"}</FieldLabel>
              <input id="ai-base-url" data-testid="ai-settings-base-url" type="url" autoComplete="off" spellCheck={false}
                placeholder={custom ? "https://ai.example.com/v1/chat/completions" : "http://localhost:11434"}
                value={draft.baseUrl} onChange={(e) => change("baseUrl", e.target.value)} aria-describedby="ai-base-url-hint" required={custom} className={FIELD_CLASS} />
              <FieldDescription id="ai-base-url-hint">
                {custom ? "Enter the full endpoint URL. Your integration must accept OpenAI-compatible chat requests and responses. API-version query parameters are supported; put secrets in headers." : "Enter the server root, without a trailing /v1."}
                {view?.envHint.baseUrlEnv ? <> Environment: <code>{view.envHint.baseUrlEnv}</code>.</> : null}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ai-model">Model</FieldLabel>
              <input id="ai-model" data-testid="ai-settings-model" autoComplete="off" spellCheck={false} placeholder={custom ? "Your integration's model identifier" : "llama3"}
                required={custom} value={draft.model} onChange={(e) => change("model", e.target.value)} className={FIELD_CLASS} />
              <FieldDescription>{custom ? "Use the exact model identifier accepted by your endpoint." : "Empty uses " + (view?.envHint.modelEnv ?? "llama3") + "."}</FieldDescription>
            </Field>
            {custom && (
              <fieldset className="flex min-w-0 flex-col gap-space-4 rounded-lg border border-border p-space-4">
                <legend className="px-1 text-body-small font-medium">Authentication & integration</legend>
                <Field>
                  <FieldLabel htmlFor="ai-api-key">API key (optional bearer token)</FieldLabel>
                  <input id="ai-api-key" data-testid="ai-settings-api-key-input" type="password" autoComplete="new-password"
                    value={draft.apiKey} onChange={(e) => { change("apiKey", e.target.value); change("clearCredentials", false); }}
                    placeholder={view?.credentialsConfigured ? "Leave blank to keep the saved key" : "Enter a key if your endpoint requires one"} className={FIELD_CLASS} />
                  <FieldDescription data-testid="ai-settings-api-key">
                    {view?.apiKeyConfigured ? "An API key is configured. Saved credentials are encrypted and never shown." : "No API key is configured. Endpoints without authentication can leave this empty."}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="ai-headers">Additional headers (JSON, optional)</FieldLabel>
                  <textarea id="ai-headers" data-testid="ai-settings-headers" autoComplete="off" spellCheck={false} rows={3}
                    value={draft.headers} onChange={(e) => { change("headers", e.target.value); change("clearCredentials", false); }}
                    placeholder={'{"api-key": "your-key", "x-project-id": "your-project"}'} className={FIELD_CLASS} />
                  <FieldDescription>{view?.headersConfigured ? "Headers are saved. Leave blank to keep them, or enter {} to remove them." : "Use headers for a custom authentication header, project, or organization. Values are encrypted and never read back."}</FieldDescription>
                </Field>
                {view?.credentialsConfigured && <Button type="button" variant="outline" onClick={() => { setDraft((current) => ({ ...current, apiKey: "", headers: "", clearCredentials: !current.clearCredentials })); setSaved(false); setTest(null); }}>
                  {draft.clearCredentials ? "Keep saved credentials" : "Remove saved credentials on save"}
                </Button>}
                <FieldDescription>Changing the endpoint or provider discards its saved credentials. Enter credentials again for the new endpoint.</FieldDescription>
              </fieldset>
            )}
            {!custom && <FieldDescription data-testid="ai-settings-api-key">{view?.apiKeyConfigured ? "An API key is configured on the server." : "Set AI_API_KEY on the server if this provider requires a bearer token."}</FieldDescription>}
            {custom && <FieldDescription>Testing sends a short chat request and may consume tokens from the selected model.</FieldDescription>}
            <div className="flex flex-wrap items-center gap-space-2">
              <Button type="submit" data-testid="ai-settings-save" disabled={busy !== null || !dirty}>
                {busy === "save" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Save
              </Button>
              <Button type="button" variant="outline" data-testid="ai-settings-test" disabled={busy !== null} onClick={() => void runTest()}>
                {busy === "test" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Test connection
              </Button>
              {hasOverride && <Button type="button" variant="ghost" data-testid="ai-settings-clear" onClick={() => void save({ ...EMPTY, clearCredentials: true })}>Clear saved settings</Button>}
            </div>
            <div aria-live="polite" className="min-h-5">
              {saved && <p data-testid="ai-settings-saved" className="text-body-small text-foreground">Saved.</p>}
              {test && <p data-testid="ai-settings-test-result" data-reachable={String(test.reachable)} className={test.reachable ? "text-body-small text-foreground" : "text-body-small text-destructive"}>
                {test.reachable ? "Reachable: " : "Not reachable: "}{test.detail}
              </p>}
            </div>
          </FieldGroup>
        </fieldset>
      </form>
    </div>
  );
}
