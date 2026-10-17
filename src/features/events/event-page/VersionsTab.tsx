"use client";

// src/features/events/event-page/VersionsTab.tsx
// The Versions tab: the event's published versions, newest first, and the stored AsyncAPI code of the one the user views (read-only,
// YAML or JSON, same look as the code panel). The page owns which version is shown (it writes ?version=); a version that cannot be
// loaded shows its error under the list and leaves the list as it is.
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";
import { EventVersionList } from "@/features/events/shared/EventVersionList";
import { useEventVersionCode, useEventVersions } from "./use-event-versions";

type Format = "yaml" | "json";
const FORMAT_LABEL: Record<Format, string> = { yaml: "YAML", json: "JSON" };

export interface VersionsTabProps {
  eventId: string;
  productId: string;
  /** The event's latest published label: a change (a publish from the page header) reloads the list. */
  latestLabel: string | null;
  /** The version being viewed (`?version=`); null = none. */
  version: string | null;
  onVersionChange: (label: string) => void;
}

export function VersionsTab({ eventId, productId, latestLabel, version, onVersionChange }: VersionsTabProps) {
  const { versions, error } = useEventVersions({ eventId, productId, latestLabel });
  return (
    <div data-testid="event-versions" className="space-y-space-6">
      <section className="space-y-space-3">
        <h2 className="text-heading-2 text-foreground">Published versions</h2>
        {error ? (
          <p role="alert" data-testid="event-versions-error" className="text-body-small text-destructive">Could not load published versions: {error}</p>
        ) : versions === null ? (
          <p data-testid="event-versions-loading" className="flex items-center gap-2 text-body-small text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading published versions…
          </p>
        ) : (
          <EventVersionList versions={versions} emptyText="Not published yet." onView={onVersionChange} selectedLabel={version} />
        )}
      </section>
      {version !== null && <VersionCode eventId={eventId} productId={productId} label={version} />}
    </div>
  );
}

/** One stored version's code. The YAML / JSON choice stays when the user views another version, so two versions compare in one format. */
function VersionCode({ eventId, productId, label }: { eventId: string; productId: string; label: string }) {
  const code = useEventVersionCode({ eventId, productId, label });
  const [format, setFormat] = useState<Format>("yaml");
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current !== null) clearTimeout(copiedTimer.current); }, []);

  const text = code.status === "ready" ? code[format] : "";

  async function copy() {
    if (code.status !== "ready") return;
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

  return (
    <section data-testid="event-version-code" aria-label={`AsyncAPI of version ${label}`} className="space-y-space-2">
      <div className="flex flex-wrap items-center justify-between gap-space-2">
        <h3 className="text-heading-3 text-foreground">AsyncAPI · v{label}</h3>
        <div className="flex items-center gap-space-2">
          <div role="group" aria-label="Code format" className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {(["yaml", "json"] as const).map((f) => (
              <Button
                key={f} type="button" size="xs" variant={format === f ? "secondary" : "ghost"} aria-pressed={format === f}
                data-testid={`version-code-format-${f}`} onClick={() => setFormat(f)}
              >
                {FORMAT_LABEL[f]}
              </Button>
            ))}
          </div>
          <Button type="button" size="xs" variant="outline" disabled={code.status !== "ready"} onClick={() => { void copy(); }} data-testid="version-code-copy" className="gap-1">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      {code.status === "error" && (
        <p role="alert" data-testid="event-version-code-error" className="text-body-small text-destructive">
          Could not load v{label}: {code.message}{" "}
          <button
            type="button" data-testid="event-version-code-retry" onClick={code.retry}
            className="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Retry
          </button>
        </p>
      )}
      {code.status === "loading" && (
        <p data-testid="event-version-code-loading" className="flex items-center gap-2 text-body-small text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading v{label}…
        </p>
      )}
      {code.status === "ready" && (
        <div className="h-[28rem] overflow-hidden rounded-lg border border-border p-space-2">
          <JsonEditor
            id="event-version-code-text" value={text} language={format} readOnly height="100%"
            ariaLabel={`AsyncAPI document of version ${label} as ${FORMAT_LABEL[format]}`}
          />
        </div>
      )}
    </section>
  );
}
