"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAiSettingsAction, testAiConnectionAction, updateAiSettingsAction } from "@/app/(dashboard)/admin/actions";
import type { AiConfigSource, AiSettingsView } from "@/services/ai-config.service";

const FIELD_CLASS = "w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary";

const SOURCE_LABEL: Record<AiConfigSource, string> = {
  db: "Saved on this page",
  env: "Server environment (AI_PROVIDER, AI_BASE_URL)",
  legacy: "Server environment (OLLAMA_HOST / OPENAI_BASE_URL)",
  none: "Not configured",
};

type Draft = { provider: string; baseUrl: string; model: string };

const toDraft = (view: AiSettingsView): Draft => ({
  provider: view.stored.provider ?? "",
  baseUrl: view.stored.baseUrl ?? "",
  model: view.stored.model ?? "",
});

/**
 * The AI provider settings of the Admin area. The API key is never loaded or sent: it is the server's secret (AI_API_KEY) and the page only
 * says whether one is set. The server asks `ai.manage` on every action; this form is what a platform administrator is shown.
 */
export function AiSettingsForm() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [draft, setDraft] = useState<Draft>({ provider: "", baseUrl: "", model: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ reachable: boolean; detail: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getAiSettingsAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
    } else {
      setView(res.data);
      setDraft(toDraft(res.data));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function change(field: keyof Draft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setTest(null);
  }

  async function save(next: Draft) {
    setBusy("save");
    setError(null);
    setSaved(false);
    const res = await updateAiSettingsAction(next);
    if ("error" in res) {
      setError(res.error ?? "Request failed");
    } else {
      setView(res.data);
      setDraft(toDraft(res.data));
      setSaved(true);
      setTest(null);
    }
    setBusy(null);
  }

  async function runTest() {
    setBusy("test");
    setError(null);
    setTest(null);
    const res = await testAiConnectionAction(draft);
    if ("error" in res) {
      setError(res.error ?? "Request failed");
    } else {
      setTest(res.data);
    }
    setBusy(null);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-space-2 text-body-small text-muted-foreground py-space-6" role="status">
        <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" />
        Loading AI settings…
      </div>
    );
  }

  const stored = view?.stored;
  const hasOverride = Boolean(stored && (stored.provider || stored.baseUrl || stored.model));
  const effective = view?.effective ?? null;
  const dirty = stored !== undefined && (draft.provider !== (stored.provider ?? "") || draft.baseUrl !== (stored.baseUrl ?? "") || draft.model !== (stored.model ?? ""));

  return (
    <div className="max-w-2xl space-y-space-4" data-testid="ai-settings">
      {error && (
        <div role="alert" data-testid="ai-settings-error" className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive">
          {error}
        </div>
      )}

      <section aria-labelledby="ai-effective-title" data-testid="ai-settings-effective" className="rounded-lg border border-border p-space-4 space-y-space-1">
        <h3 id="ai-effective-title" className="text-heading-4 text-foreground">In use now</h3>
        {effective ? (
          <p className="text-body-small text-foreground">
            <span data-testid="ai-settings-effective-provider">{effective.provider === "ollama" ? "Ollama" : "vLLM / OpenAI-compatible"}</span> at{" "}
            <code className="text-caption">{effective.baseUrl}</code>, model <code className="text-caption">{effective.model}</code>
          </p>
        ) : (
          <p className="text-body-small text-muted-foreground">No AI provider is configured, so AI-assisted creation is off.</p>
        )}
        <p className="text-caption text-muted-foreground" data-testid="ai-settings-source">
          Source: {SOURCE_LABEL[effective?.source ?? "none"]}
        </p>
      </section>

      <form
        className="space-y-space-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft);
        }}
      >
        <div className="space-y-space-1">
          <label htmlFor="ai-provider" className="block text-caption text-muted-foreground">Provider</label>
          <select id="ai-provider" data-testid="ai-settings-provider" className={FIELD_CLASS} value={draft.provider} onChange={(event) => change("provider", event.target.value)}>
            <option value="">Not set (use the server environment)</option>
            <option value="ollama">Ollama</option>
            <option value="vllm">vLLM / OpenAI-compatible</option>
          </select>
        </div>

        <div className="space-y-space-1">
          <label htmlFor="ai-base-url" className="block text-caption text-muted-foreground">Base URL</label>
          <input
            id="ai-base-url"
            data-testid="ai-settings-base-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://localhost:11434"
            value={draft.baseUrl}
            onChange={(event) => change("baseUrl", event.target.value)}
            aria-describedby="ai-base-url-hint"
            className={FIELD_CLASS}
          />
          <p id="ai-base-url-hint" className="text-caption text-muted-foreground">
            The server root, without a trailing /v1. The server calls this address, so point it only at a host you trust.
            {view?.envHint.baseUrlEnv ? <> The environment gives <code>{view.envHint.baseUrlEnv}</code>.</> : null}
          </p>
        </div>

        <div className="space-y-space-1">
          <label htmlFor="ai-model" className="block text-caption text-muted-foreground">Model</label>
          <input
            id="ai-model"
            data-testid="ai-settings-model"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="llama3"
            value={draft.model}
            onChange={(event) => change("model", event.target.value)}
            className={FIELD_CLASS}
          />
          <p className="text-caption text-muted-foreground">
            Empty uses {view?.envHint.modelEnv ? <><code>{view.envHint.modelEnv}</code> from the environment</> : "llama3"}.
          </p>
        </div>

        <p data-testid="ai-settings-api-key" className="text-caption text-muted-foreground">
          {view?.apiKeyConfigured
            ? "AI_API_KEY is set on the server; it is sent as a bearer token."
            : "No API key. If your endpoint needs a bearer token, set AI_API_KEY in the server environment (it is never stored or shown here)."}
        </p>

        <div className="flex flex-wrap items-center gap-space-2">
          <Button type="submit" data-testid="ai-settings-save" disabled={busy !== null || !dirty}>
            {busy === "save" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Save
          </Button>
          <Button type="button" variant="outline" data-testid="ai-settings-test" disabled={busy !== null} onClick={() => void runTest()}>
            {busy === "test" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Test connection
          </Button>
          {hasOverride && (
            <Button type="button" variant="ghost" data-testid="ai-settings-clear" disabled={busy !== null} onClick={() => void save({ provider: "", baseUrl: "", model: "" })}>
              Clear saved settings
            </Button>
          )}
        </div>

        <div aria-live="polite" className="min-h-5">
          {saved && <p data-testid="ai-settings-saved" className="text-body-small text-foreground">Saved.</p>}
          {test && (
            <p data-testid="ai-settings-test-result" data-reachable={test.reachable ? "true" : "false"} className={test.reachable ? "text-body-small text-foreground" : "text-body-small text-destructive"}>
              {test.reachable ? "Reachable: " : "Not reachable: "}
              {test.detail}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
