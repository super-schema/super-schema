"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Download, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { highlightLine } from "@/lib/syntax-highlight";
import type { EventSpecEmission } from "@/services/events/event-spec-emit.service";

const MIME = { yaml: "application/yaml", json: "application/json" } as const;

/** The same document over REST (T13): `version` is "draft" or MAJOR.MINOR, exactly what the emission reports. */
const restHref = (e: EventSpecEmission, format: "yaml" | "json") =>
  `/api/v1/event-specs/${encodeURIComponent(e.specId)}?version=${encodeURIComponent(e.version)}&format=${format}`;

/** A spec name is user input; keep the saved file name to ASCII letters, digits, `.`, `_`, `-`. */
const fileStem = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "event-spec";

/** A failed emission read: the (client-safe) message and a retry — shared by the Document, Preview and Diagnostics tabs. */
export function EmissionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-space-2 text-body-small text-destructive">
      <p>{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function DocumentView({
  emission, loading, error, onRetry,
}: { emission: EventSpecEmission | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const [format, setFormat] = useState<"yaml" | "json">("yaml");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (loading) return <p className="flex items-center gap-2 text-body-small text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Rendering payloads and validating with @asyncapi/parser…</p>;
  if (error) return <EmissionError message={error} onRetry={onRetry} />;
  if (!emission) return null;
  if (!emission.document || !emission.yaml || !emission.json) {
    return <p className="text-body-small text-muted-foreground">No document — see the Diagnostics tab for unresolved references.</p>;
  }
  const text = format === "yaml" ? emission.yaml : emission.json;
  const fileName = `${fileStem(emission.specName)}-${emission.version}.asyncapi.${format}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: MIME[format] }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-space-2">
      <div className="flex flex-wrap items-center gap-space-2">
        <div role="group" aria-label="Format" className="flex rounded-md border border-border">
          {(["yaml", "json"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFormat(f)} aria-pressed={format === f}
              className={`px-space-3 py-1 text-body-small ${format === f ? "bg-accent text-foreground" : "text-muted-foreground"}`}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-caption text-muted-foreground">{emission.published ? `v${emission.version} (stored)` : "draft"}</span>
        <div className="ml-auto flex flex-wrap gap-space-2">
          <a href={restHref(emission, format)} target="_blank" rel="noopener noreferrer" data-testid="document-rest-link"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-space-3 py-1 text-body-small text-foreground hover:bg-accent">
            <ExternalLink className="w-4 h-4" aria-hidden="true" /> Open via API
          </a>
          <Button size="sm" variant="outline" onClick={copy} data-testid="document-copy" className="gap-1.5">{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} Copy</Button>
          <Button size="sm" variant="outline" onClick={download} data-testid="document-download" className="gap-1.5"><Download className="w-4 h-4" /> Download</Button>
        </div>
      </div>
      <pre className="max-h-[70vh] overflow-auto rounded-md border border-border/50 bg-muted/20 p-space-3 text-caption font-mono" data-testid="document-text">
        <code>
          {text.split("\n").map((line, i) => (
            <div key={i} className="flex">
              <span className="inline-block w-10 select-none pr-3 text-right text-muted-foreground/50">{i + 1}</span>
              <span className="flex-1">{highlightLine(line, format)}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
