"use client";

// src/features/events/event-page/EventCodePanel.tsx
// The live Code view in the shell's right Detail Panel: the AsyncAPI document of the draft being built, as YAML or JSON.
// The code follows every edit at once (placeholder payload schemas, built in the browser) and is swapped for the server's full
// render (real schemas) when that arrives for the same document. Diagnostics sit above the code.
import { memo, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DiagnosticsList } from "@/features/events/event-specs/DiagnosticsList";
import { highlightLine } from "@/lib/syntax-highlight";
import { useEventCodeSource, type EventCodeSource } from "./event-code-source";
import { useEventCode, type CodeStatus } from "./use-event-code";

type Format = "yaml" | "json";
const FORMAT_LABEL: Record<Format, string> = { yaml: "YAML", json: "JSON" };

/** Above this many lines the code is shown uncoloured: one element per token on every keystroke is not worth it. */
export const MAX_HIGHLIGHTED_LINES = 3000;

const CHIP: Record<CodeStatus, { label: string; title: string; variant: "secondary" | "success" | "outline" }> = {
  draft: { label: "Draft preview", title: "Payload schemas are placeholders (Entity@version).", variant: "secondary" },
  rendering: { label: "Draft preview", title: "Payload schemas are placeholders (Entity@version) while the full schemas render…", variant: "secondary" },
  full: { label: "Full schemas", title: "The real payload schemas of your entities, rendered on the server.", variant: "success" },
  error: { label: "Draft preview", title: "The full schemas could not be loaded, so the payload schemas are placeholders.", variant: "outline" },
};

/** Read-only code with a line-number gutter (not part of the selection) and light syntax colouring. */
const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: Format }) {
  const { lines, gutter } = useMemo(() => {
    const all = code.split("\n");
    const endsWithNewline = all[all.length - 1] === "";
    if (endsWithNewline) all.pop();
    const colour = all.length <= MAX_HIGHLIGHTED_LINES;
    return {
      gutter: all.map((_, i) => `${i + 1}\n`).join(""),
      lines: all.map((line, i) => (
        <Fragment key={i}>
          {colour ? highlightLine(line, language) : line}
          {i < all.length - 1 || endsWithNewline ? "\n" : ""}
        </Fragment>
      )),
    };
  }, [code, language]);
  return (
    <div className="flex min-w-max font-mono text-[12px] leading-5">
      <div data-testid="code-gutter" aria-hidden="true" className="sticky left-0 select-none whitespace-pre bg-muted px-space-2 text-right text-muted-foreground/60">{gutter}</div>
      <pre data-language={language} className="flex-1 whitespace-pre px-space-3"><code data-testid="code-text">{lines}</code></pre>
    </div>
  );
});

/**
 * Props are the page's unsaved draft (see `event-code-source.tsx`). Everything this does (the instant build, the debounced server
 * call) lives here, so it runs only while the shell actually renders the panel: a collapsed right panel does not mount its content.
 */
export function EventCodePanel({ eventId, productId, productSlug, doc, problems, entityLabels, versionLabels }: EventCodeSource) {
  const code = useEventCode({ eventId, productId, productSlug, doc, blocked: problems.length > 0, entityLabels, versionLabels });
  const [format, setFormat] = useState<Format>("yaml");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) clearTimeout(copiedTimer.current); }, []);

  const text = format === "yaml" ? code.yaml : code.json;
  const hasCode = code.document !== null && text !== "";

  async function copy() {
    if (!hasCode) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error("Could not copy the code");
      return;
    }
    toast.success(`${FORMAT_LABEL[format]} copied`);
    setCopied(true);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }

  // Diagnostics: collapsed unless something is an error; a click overrides that for as long as the panel stays mounted.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const diagnosticCount = code.diagnostics.length;
  const hasError = code.diagnostics.some((d) => d.severity === "error");
  const open = diagnosticCount > 0 && (userOpen ?? hasError);
  const chip = CHIP[code.status];

  return (
    <div data-testid="event-code-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-space-2 border-b border-border/50 px-space-3 py-space-2">
        <div className="flex items-center gap-space-2">
          <h2 className="text-body-small font-medium text-foreground">AsyncAPI</h2>
          {hasCode && (
            <Badge variant={chip.variant} data-testid="code-status" data-state={code.status} title={chip.title}>
              {code.status === "rendering" && <Loader2 className="animate-spin" aria-hidden="true" />}
              {chip.label}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          <div role="group" aria-label="Code format" data-testid="code-format" className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {(["yaml", "json"] as const).map((f) => (
              <Button
                key={f} type="button" size="xs" variant={format === f ? "secondary" : "ghost"} aria-pressed={format === f}
                data-testid={`code-format-${f}`} onClick={() => setFormat(f)}
              >
                {FORMAT_LABEL[f]}
              </Button>
            ))}
          </div>
          <Button type="button" size="xs" variant="outline" disabled={!hasCode} onClick={() => { void copy(); }} data-testid="code-copy" className="gap-1">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      <section data-testid="code-diagnostics" aria-label="Diagnostics" className="shrink-0 border-b border-border/50">
        {diagnosticCount === 0 ? (
          <p className="px-space-3 py-space-2 text-caption text-muted-foreground">No problems</p>
        ) : (
          <>
            <button
              type="button" data-testid="code-diagnostics-toggle" aria-expanded={open} aria-controls="event-code-diagnostics"
              onClick={() => setUserOpen(!open)}
              className="flex w-full items-center gap-space-2 px-space-3 py-space-2 text-left text-body-small text-foreground outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
              Diagnostics
              <Badge variant={hasError ? "destructive" : "secondary"} data-testid="code-diagnostics-count">{diagnosticCount}</Badge>
            </button>
            {open && (
              <div id="event-code-diagnostics" className="max-h-56 space-y-space-2 overflow-auto px-space-3 pb-space-3">
                <p className="text-caption text-muted-foreground">A pointer refers either to your draft or to the generated AsyncAPI document.</p>
                <DiagnosticsList diagnostics={code.diagnostics} unpublishedMessages={[]} />
              </div>
            )}
          </>
        )}
      </section>

      {hasCode ? (
        <div role="region" aria-label="AsyncAPI code" tabIndex={0} className="min-h-0 flex-1 overflow-auto bg-muted/30 py-space-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <CodeBlock code={text} language={format} />
        </div>
      ) : (
        <div data-testid="code-empty" className="flex flex-1 items-start p-space-4">
          <p className="text-body-small text-muted-foreground">Fix the problems in Design to see the code. The diagnostics above say what is missing.</p>
        </div>
      )}

      {code.status === "error" && (
        <p role="status" data-testid="code-error-note" className="shrink-0 border-t border-border/50 px-space-3 py-space-2 text-caption text-muted-foreground">
          Full schemas are unavailable ({code.error}). Showing the draft preview.{" "}
          <button type="button" data-testid="code-retry" onClick={code.retry} className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

/** What the page pushes into the shell: the panel wired to the page's draft store. */
export function ConnectedEventCodePanel() {
  return <EventCodePanel {...useEventCodeSource()} />;
}
