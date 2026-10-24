"use client";

import { SchemaFileSet } from "@/components/custom/SchemaFileSet/SchemaFileSet";
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
 */
export function SchemaVersionOutput({ version, entityId, entityName, language, onCopy }: SchemaVersionOutputProps) {
  const { files, resolution } = version;
  const name = entityName ?? resolution?.entities.find((e) => e.ref.entityId === entityId)?.ref.entity ?? resolution?.entities[0]?.ref.entity ?? "this entity";
  const fileSet = files && files.length > 0 && (files.length > 1 || (resolution?.entities.length ?? 0) > 1) ? files : undefined;

  return (
    <div className="space-y-space-3">
      <SchemaReferencesUsed resolution={resolution} entityId={entityId} />
      {fileSet ? (
        <SchemaFileSet files={fileSet} entityName={name} entities={resolution?.entities} language={language} onCopy={onCopy} />
      ) : (
        <SchemaCodePreview code={version.output} language={language} onCopy={onCopy} />
      )}
    </div>
  );
}
