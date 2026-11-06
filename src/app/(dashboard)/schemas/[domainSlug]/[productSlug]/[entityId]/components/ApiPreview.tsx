"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { OpenApiPreview, PreviewBody, PreviewOperation } from "@/lib/api-operations/openapi-preview";
import { previewEntityOpenApiAction, type EntityOpenApiPreview } from "../api-preview-actions";
import { SchemaCodePreview } from "./SchemaCodePreview";

export interface ApiPreviewProps {
  entityId: string;
}

type Loaded = { key: number; result: EntityOpenApiPreview; summary: OpenApiPreview | null };
type View = "operations" | "yaml";

/**
 * Read-only preview of the entity's emitted OpenAPI 3 document (the `openapi3` target, draft, nothing stored): an operation list with
 * example payloads (`openapi-sampler`) and the YAML itself, plus the emitter's warnings / errors. The summarizer (yaml + sampler) is
 * loaded lazily, only when the preview is opened.
 */
export function ApiPreview({ entityId }: ApiPreviewProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [view, setView] = useState<View>("operations");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let result: EntityOpenApiPreview;
      try {
        result = await previewEntityOpenApiAction(entityId);
      } catch {
        result = { error: "The preview could not be loaded" };
      }
      let summary: OpenApiPreview | null = null;
      if (result.success && result.yaml) {
        const { summarizeOpenApi } = await import("@/lib/api-operations/openapi-preview");
        summary = summarizeOpenApi(result.yaml);
      }
      if (!cancelled) setLoaded({ key: reloadKey, result, summary });
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const loading = !loaded || loaded.key !== reloadKey;
  const result = loaded?.result;
  const summary = loaded?.summary ?? null;

  return (
    <div data-testid="api-preview" className="flex flex-col gap-space-3">
      <div className="flex items-center justify-between gap-space-2">
        <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Preview view">
          {(["operations", "yaml"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`px-space-3 py-1.5 text-body-small border-b-2 transition-colors ${
                view === v ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {v === "operations" ? "Operations" : "OpenAPI YAML"}
            </button>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading} data-testid="api-preview-refresh">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {loading && !result ? <p className="text-caption text-muted-foreground">Generating the OpenAPI document…</p> : null}

      {result && !result.success ? (
        <Messages kind="error" messages={[result.error]} />
      ) : result?.success ? (
        <>
          <Messages kind="error" messages={result.errors} />
          <Messages kind="warning" messages={result.warnings} />
          {result.yaml ? (
            view === "yaml" ? (
              <SchemaCodePreview code={result.yaml} language="yaml" title={result.path || "openapi.yaml"} onCopy={() => undefined} />
            ) : summary && summary.error === undefined ? (
              <OperationList summary={summary} />
            ) : (
              <Messages kind="error" messages={[summary?.error ?? "The document could not be read"]} />
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Messages({ kind, messages }: { kind: "error" | "warning"; messages: string[] }) {
  if (messages.length === 0) return null;
  const Icon = kind === "error" ? AlertCircle : AlertTriangle;
  return (
    <div
      data-testid={`api-preview-${kind}s`}
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-md border p-space-3 text-caption ${
        kind === "error" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-muted/40 text-muted-foreground"
      }`}
    >
      <ul className="flex flex-col gap-1">
        {messages.map((m, i) => (
          <li key={i} className="flex gap-space-2">
            <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="break-words">{m}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OperationList({ summary }: { summary: Exclude<OpenApiPreview, { error: string }> }) {
  if (summary.operations.length === 0) {
    return <p className="text-caption text-muted-foreground">The document has no operations yet. Add an operation to see it here.</p>;
  }
  return (
    <div className="flex flex-col gap-space-2" data-testid="api-preview-operations">
      <p className="text-caption text-muted-foreground">
        {summary.title} {summary.version ? `v${summary.version}` : ""} · OpenAPI {summary.openapi} · {summary.operations.length} operation
        {summary.operations.length === 1 ? "" : "s"}
      </p>
      {summary.operations.map((op) => (
        <OperationCard key={`${op.method} ${op.path}`} op={op} />
      ))}
    </div>
  );
}

function OperationCard({ op }: { op: PreviewOperation }) {
  return (
    <details className="rounded-md border border-border bg-card" data-testid="api-preview-operation">
      <summary className="flex cursor-pointer items-center gap-space-2 px-space-3 py-space-2 text-body-small">
        <span className="inline-block min-w-14 rounded bg-muted px-1.5 py-0.5 text-center font-mono text-caption font-semibold">{op.method}</span>
        <span className={`font-mono ${op.deprecated ? "line-through text-muted-foreground" : ""}`}>{op.path}</span>
        {op.summary ? <span className="truncate text-muted-foreground">{op.summary}</span> : null}
        {op.deprecated ? <span className="text-caption text-muted-foreground">(deprecated)</span> : null}
      </summary>
      <div className="flex flex-col gap-space-3 border-t border-border px-space-3 py-space-3 text-caption">
        {op.operationId || op.tags.length ? (
          <p className="text-muted-foreground">
            {op.operationId ? <>operationId <code className="font-mono text-foreground">{op.operationId}</code></> : null}
            {op.tags.length ? <> · tags {op.tags.join(", ")}</> : null}
          </p>
        ) : null}
        {op.description ? <p>{op.description}</p> : null}
        {op.parameters.length ? (
          <section>
            <h4 className="mb-1 font-medium">Parameters</h4>
            <table className="w-full text-left">
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}:${p.name}`} className="border-t border-border/50">
                    <td className="py-1 pr-space-2 font-mono">
                      {p.name}
                      {p.required ? <span className="text-destructive">*</span> : null}
                    </td>
                    <td className="py-1 pr-space-2 text-muted-foreground">{p.in}</td>
                    <td className="py-1 pr-space-2 font-mono">{p.type}</td>
                    <td className="py-1 text-muted-foreground">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {op.requestBody ? (
          <section>
            <h4 className="mb-1 font-medium">
              Request body{op.requestBody.required ? <span className="text-destructive">*</span> : null}
            </h4>
            <Body body={op.requestBody} />
          </section>
        ) : null}
        {op.responses.length ? (
          <section>
            <h4 className="mb-1 font-medium">Responses</h4>
            <div className="flex flex-col gap-space-2">
              {op.responses.map((r) => (
                <div key={r.status}>
                  <p>
                    <span className="font-mono font-semibold">{r.status}</span> <span className="text-muted-foreground">{r.description}</span>
                  </p>
                  {r.body ? <Body body={r.body} /> : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function Body({ body }: { body: PreviewBody }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">
        <span className="font-mono text-foreground">{body.type}</span> · {body.contentType}
      </p>
      {body.example ? (
        <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-space-2 font-mono text-[12px] leading-5">{body.example}</pre>
      ) : null}
    </div>
  );
}
