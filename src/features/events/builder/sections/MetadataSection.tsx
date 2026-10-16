"use client";

// src/features/events/builder/sections/MetadataSection.tsx
// Metadata: the AsyncAPI info object as a template form (every property the spec defines, the title required, the rest under
// "More properties") plus the document's default content type. Nothing here asks the user for a key or a version: the version is
// set when the event is published.
import type { EventSpecInfo } from "@/lib/event-specs/types";
import { TEMPLATES, type ObjectTemplate } from "@/lib/events/templates";
import { setOptionalString } from "../controls";
import type { SectionProps } from "../EventBuilder";
import { uniqueProblems } from "../problems";
import { TemplateForm } from "../template";

/** Suggestions only: any media type is accepted. */
const COMMON_CONTENT_TYPES = ["application/json", "application/avro", "application/vnd.apache.avro+json", "application/x-protobuf", "text/plain"];

/** `defaultContentType` lives on the document, not on `info`, so it is a tiny template of its own. */
const DEFAULTS_TEMPLATE: ObjectTemplate = {
  id: "info",
  label: "Defaults",
  fields: [{
    key: "defaultContentType", label: "Default content type", kind: "text", group: "basics",
    help: "Used by every message that does not set its own content type.",
    placeholder: "application/json", suggestions: COMMON_CONTENT_TYPES,
  }],
};

/** The form gives back the info object with empty fields removed; the title always stays (as "" while it is empty) so the draft keeps its shape. */
function toInfo(next: Record<string, unknown>): EventSpecInfo {
  const { title, ...rest } = next;
  return { title: typeof title === "string" ? title : "", ...rest } as EventSpecInfo;
}

export function MetadataSection({ draft }: SectionProps) {
  const { doc, update } = draft;
  // The client parse and a failed save usually report the same problems: show each once.
  const problems = uniqueProblems(draft.problems.concat(draft.serverProblems));

  return (
    <section aria-labelledby="metadata-heading" data-testid="section-metadata" className="space-y-space-6">
      <header className="space-y-space-1">
        <h2 id="metadata-heading" className="text-heading-3 text-foreground">Metadata</h2>
        <p className="text-body-small text-muted-foreground">Describes the whole API. The event&apos;s name is in the page header; its version is set when you publish.</p>
      </header>

      <div className="max-w-2xl space-y-space-6">
        <TemplateForm
          template={TEMPLATES.info} value={{ ...doc.info }} idPrefix="metadata" errors={problems} errorPrefix="/info"
          onChange={(next) => update((d) => ({ ...d, info: toInfo(next) }))}
        />
        <div className="space-y-space-3 border-t border-border pt-space-4">
          <h3 className="text-body font-medium text-foreground">Defaults</h3>
          <TemplateForm
            template={DEFAULTS_TEMPLATE} value={doc.defaultContentType === undefined ? {} : { defaultContentType: doc.defaultContentType }}
            idPrefix="metadata" errors={problems}
            onChange={(next) => update((d) => setOptionalString(d, "defaultContentType", typeof next.defaultContentType === "string" ? next.defaultContentType : ""))}
          />
        </div>
      </div>
    </section>
  );
}
