"use client";

import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { draftReferencedEntities, referencedResolutionEntries } from "@/lib/entity-versioning/schema-version-publishability";
import type { EntityRef } from "@/lib/references/entity-reference";
import type { SchemaVersionResolution } from "@/types/schema-version";

type ResolutionEntry = SchemaVersionResolution["entities"][number];

/** `domain / product / entity`: the one way a reference is shown. */
const refLabel = (ref: EntityRef) => `${ref.domain} / ${ref.product} / ${ref.entity}`;

function versionText(entry: ResolutionEntry): { version: string | null; note: string } {
  if (entry.source === "draft") return { version: null, note: "draft (saved, not published)" };
  const version = entry.version ? `v${entry.version}` : null;
  return { version, note: entry.source === "pinned" ? "(pinned)" : "(latest published)" };
}

interface SchemaReferencesUsedProps {
  /** Absent on a version stored before multi-entity emission, and on the DB targets: nothing is shown. */
  resolution: SchemaVersionResolution | undefined;
  /** The entity the version was generated for (its own entry in the resolution is not a reference). */
  entityId: string;
}

/**
 * What a generated version used of the entities it REFERENCES. A version generated from the entity page is a preview of the saved
 * draft, so `resolution.preview` is true even with no reference at all: the Preview badge (and its list) is therefore based on the
 * referenced entities resolved at draft state only. Below it, every referenced entity with the version it used: pinned, the latest
 * published, or the saved draft.
 */
export function SchemaReferencesUsed({ resolution, entityId }: SchemaReferencesUsedProps) {
  const referenced = referencedResolutionEntries(resolution, entityId);
  if (referenced.length === 0) return null;
  const drafts = draftReferencedEntities(resolution, entityId);

  return (
    <div className="space-y-space-2">
      {drafts.length > 0 && (
        <div data-testid="schema-draft-references" className="rounded-lg border border-warning/30 bg-warning/5 p-space-3">
          <div className="flex items-center gap-1.5">
            <Badge variant="warning" data-testid="schema-preview-badge" className="gap-1">
              <AlertTriangle aria-hidden="true" />
              Preview (drafts used)
            </Badge>
          </div>
          <p className="mt-space-1 text-caption text-foreground">
            Generated from the saved draft of {drafts.length === 1 ? "an entity" : `${drafts.length} entities`} it references, so it cannot be published as
            it is. Publishing offers to regenerate it from the published versions.
          </p>
          <ul data-testid="schema-draft-reference-list" className="mt-space-1 list-disc pl-5 font-mono text-caption text-foreground">
            {drafts.map((ref, index) => (
              <li key={`${ref.entityId ?? refLabel(ref)}:${index}`} data-testid="schema-draft-reference">
                {refLabel(ref)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-border/50 bg-muted/10 p-space-3">
        <p className="text-caption font-medium text-foreground">References used</p>
        <ul data-testid="schema-reference-versions" className="mt-space-1 space-y-0.5">
          {referenced.map((entry, index) => {
            const { version, note } = versionText(entry);
            return (
              <li
                key={`${entry.ref.entityId ?? refLabel(entry.ref)}:${index}`}
                data-testid="schema-reference-version"
                data-source={entry.source}
                className="flex flex-wrap items-baseline gap-x-2 text-caption"
              >
                <span className="font-mono text-foreground">{refLabel(entry.ref)}</span>
                {version && <span className="font-mono text-foreground">{version}</span>}
                <span className={entry.source === "draft" ? "text-warning" : "text-muted-foreground"}>{note}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
