"use client";

import { EyeOff } from "lucide-react";
import { SchemaFileSet } from "@/components/custom/SchemaFileSet/SchemaFileSet";
import { HIDDEN_FILES_NOTE } from "@/lib/access/schema-version-redaction";
import type { SchemaVersion } from "@/types/schema-version";
import { SchemaCodePreview } from "./SchemaCodePreview";
import { SchemaReferencesUsed } from "./SchemaReferencesUsed";

interface SchemaVersionOutputProps {
  version: SchemaVersion;
  /** The entity the version was generated for. */
  entityId: string;
  /** Named in the file set's header; defaults to the root entity's name from the version's resolution. */
  entityName?: string;
  /** Highlighting for the code (the target's). */
  language: string;
  onCopy: () => void;
}

/**
 * One stored schema version, as shown on the Schemas tab: what it used of the entities it references (the Preview badge for draft ones
 * and the version each reference used), then its files. A version with several files (or one file that carries several entities) is a
 * file set; everything else, including every version stored before multi-entity emission (no `files`, no `resolution`), is the
 * single code preview of `output` exactly as before.
 *
 * A version the server redacted for this reader (`version.redacted`: the files of entities their roles do not cover were taken out, KD-046) says so
 * above its content; a version with nothing left to show says that instead of showing an empty editor.
 */
export function SchemaVersionOutput({ version, entityId, entityName, language, onCopy }: SchemaVersionOutputProps) {
  const { files, resolution, redacted } = version;
  const name = entityName ?? resolution?.entities.find((e) => e.ref.entityId === entityId)?.ref.entity ?? resolution?.entities[0]?.ref.entity ?? "this entity";
  const fileSet = files && files.length > 0 && (files.length > 1 || (resolution?.entities.length ?? 0) > 1) ? files : undefined;
  const nothingToShow = redacted !== undefined && (files?.length ?? 0) === 0 && version.output === "";

  return (
    <div className="space-y-space-3">
      {redacted && (
        <p
          role="note"
          data-testid="schema-version-redacted"
          data-hidden-files={redacted.hiddenFiles}
          className="flex items-start gap-1.5 rounded-lg border border-border/50 bg-muted/10 p-space-3 text-caption text-muted-foreground"
        >
          <EyeOff aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{HIDDEN_FILES_NOTE(redacted.hiddenFiles)}</span>
        </p>
      )}
      <SchemaReferencesUsed resolution={resolution} entityId={entityId} />
      {nothingToShow ? (
        <p data-testid="schema-version-nothing-to-show" className="text-caption text-muted-foreground">
          Nothing of this version can be shown for your role.
        </p>
      ) : fileSet ? (
        <SchemaFileSet files={fileSet} entityName={name} entities={resolution?.entities} language={language} onCopy={onCopy} />
      ) : (
        <SchemaCodePreview code={version.output} language={language} onCopy={onCopy} />
      )}
    </div>
  );
}
