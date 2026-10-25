"use client";

import { useMemo, useState } from "react";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SchemaCodePreview } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaCodePreview";
import { downloadFilesAsZip, zipFileName } from "./download-files";
import { zipRenames } from "@/lib/zip-store";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";
import type { SchemaVersionResolution } from "@/types/schema-version";

export interface SchemaFileSetProps {
  /** The files of the version (`SchemaVersion.files`), in the order they were stored (sorted by path). */
  files: EmittedFile[];
  /** The entity the set was generated for. */
  entityName: string;
  /**
   * `SchemaVersion.resolution.entities`: names each file's entity as `domain / product / entity` and puts the root (its first entry)
   * first. Without it the files are listed flat.
   */
  entities?: SchemaVersionResolution["entities"];
  /** The syntax highlighting for a file whose extension says nothing (`.json` and `.yaml` are recognised). */
  language?: string;
  onCopy?: () => void;
}

const OTHER_FILES = "Other files";

const refLabel = (ref: { domain: string; product: string; entity: string }) => `${ref.domain} / ${ref.product} / ${ref.entity}`;

function languageOf(path: string, fallback: string): string {
  if (/\.json$/i.test(path)) return "json";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  return fallback;
}

interface FileGroup {
  key: string;
  /** Absent when the files are listed flat. */
  label?: string;
  files: EmittedFile[];
}

/**
 * Groups by entity where the entity is known (`entityId` of a file that is in `entities`). The file list drives it, never the entity
 * list: an entity may have no file of its own (the members of a Protobuf cycle share one), and a file may carry no entity at all.
 */
function groupFiles(files: EmittedFile[], entities: SchemaFileSetProps["entities"]): FileGroup[] {
  if (!entities || entities.length === 0) return [{ key: "", files }];
  const labels = new Map<string, string>();
  for (const entity of entities) if (entity.ref.entityId) labels.set(entity.ref.entityId, refLabel(entity.ref));
  const rootId = entities[0].ref.entityId;

  const byKey = new Map<string, EmittedFile[]>();
  for (const file of files) {
    const key = file.entityId !== undefined && labels.has(file.entityId) ? file.entityId : "";
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const keys = [...byKey.keys()];
  const ordered = [
    ...(rootId !== undefined && byKey.has(rootId) ? [rootId] : []),
    ...keys.filter((key) => key !== "" && key !== rootId),
    ...(byKey.has("") ? [""] : []),
  ];
  return ordered.map((key) => ({ key, label: key === "" ? OTHER_FILES : labels.get(key), files: byKey.get(key) ?? [] }));
}

/**
 * The files one generation wrote (one per entity of the closure): the list on the left, the selected file in the code preview on the
 * right (the preview's Copy copies that file), "Download all" saving every file in one zip that keeps their paths. One file is just the
 * code preview.
 */
export function SchemaFileSet({ files, entityName, entities, language = "text", onCopy }: SchemaFileSetProps) {
  const groups = useMemo(() => groupFiles(files, entities), [files, entities]);
  const displayOrder = useMemo(() => groups.flatMap((group) => group.files), [groups]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProblem, setDownloadProblem] = useState<string | null>(null);

  if (files.length === 0) {
    return (
      <p data-testid="schema-file-set-empty" className="text-body-small text-muted-foreground">
        No files were generated for {entityName}.
      </p>
    );
  }

  // The selection survives only while its file is still in the set (a regeneration can rename or drop it).
  const selected = displayOrder.find((file) => file.path === selectedPath) ?? displayOrder[0];
  const preview = (
    <SchemaCodePreview
      code={selected.content}
      language={languageOf(selected.path, language)}
      title={selected.path}
      onCopy={onCopy ?? (() => {})}
    />
  );

  // Entities of the closure that no file carries: they are served by a shared file (Protobuf reference cycle).
  const carried = new Set(files.map((file) => file.entityId).filter((id): id is string => id !== undefined));
  const sharing = carried.size === 0 || !entities ? [] : entities.filter((e) => e.ref.entityId !== undefined && !carried.has(e.ref.entityId));

  const sharingNote =
    sharing.length > 0 ? (
      <p data-testid="schema-file-set-shared-note" className="text-caption text-muted-foreground">
        No file of its own, defined in a shared file: {sharing.map((e) => refLabel(e.ref)).join(", ")}
      </p>
    ) : null;

  async function handleDownloadAll() {
    setIsDownloading(true);
    setDownloadProblem(null);
    try {
      // One zip, every file under its path: the files point at each other by path (a Protobuf import, a Java package directory).
      await downloadFilesAsZip(files, zipFileName(entityName, files[0].target));
    } catch (e) {
      // A file name no zip can hold (RangeError: more than 65,535 bytes): said on the page, not an unhandled rejection of the click.
      setDownloadProblem(e instanceof RangeError ? e.message : "The zip could not be made.");
    } finally {
      setIsDownloading(false);
    }
  }

  // Names the zip changes (a name that differs only by case is one file on macOS and Windows; a file where a folder is): said before the download.
  const renamed = zipRenames(files.map((file) => file.path));
  const zipNote =
    renamed.length > 0 || downloadProblem !== null ? (
      <div className="space-y-1">
        {renamed.length > 0 && (
          <p data-testid="schema-file-set-zip-note" className="text-caption text-muted-foreground">
            In the zip, {renamed.slice(0, 5).map((r) => `${r.path} is saved as ${r.name}`).join("; ")}
            {renamed.length > 5 ? ` (and ${renamed.length - 5} more)` : ""}: file names that differ only by case are one file on macOS and Windows. Any
            path inside the files that names them still says the original.
          </p>
        )}
        {downloadProblem !== null && (
          <p role="alert" className="text-caption text-destructive">
            {downloadProblem}
          </p>
        )}
      </div>
    ) : null;

  const showTitles = groups.some((group) => group.label !== undefined);

  // One file is just its code (plus the note when it carries other entities too); the list and "Download all" are for several.
  if (files.length === 1) {
    return (
      <div data-testid="schema-file-set" className="space-y-space-3">
        {preview}
        {sharingNote}
      </div>
    );
  }

  return (
    <div data-testid="schema-file-set" className="space-y-space-3">
      <div className="flex items-center justify-between gap-space-2">
        <span className="text-caption text-muted-foreground">
          {files.length} files for {entityName}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={isDownloading}
          onClick={() => void handleDownloadAll()}
          data-testid="schema-file-set-download-all"
        >
          <Download className="w-3.5 h-3.5" />
          Download all ({files.length} files)
        </Button>
      </div>
      {zipNote}

      <div className="grid grid-cols-1 gap-space-3 md:grid-cols-[minmax(180px,260px)_minmax(0,1fr)]">
        <ul data-testid="schema-file-set-list" className="max-h-80 space-y-space-2 overflow-y-auto">
          {groups.map((group) => (
            <li key={group.key} data-testid="schema-file-group" data-entity-id={group.key || undefined}>
              {showTitles && (
                <p data-testid="schema-file-group-title" className="mb-1 truncate text-caption font-medium text-foreground" title={group.label}>
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.files.map((file) => {
                  const isSelected = file.path === selected.path;
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        data-testid="schema-file-item"
                        data-path={file.path}
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() => setSelectedPath(file.path)}
                        className={`flex w-full items-center gap-1.5 rounded px-space-2 py-1 text-left font-mono text-caption transition-colors ${
                          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        }`}
                      >
                        <FileText className="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span className="truncate" title={file.path}>{file.path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="min-w-0">{preview}</div>
      </div>

      {sharingNote}
    </div>
  );
}
