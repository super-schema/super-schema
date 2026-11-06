"use client";

import { useCallback, useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, ClipboardPaste, FileText, Link2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OpenApiImportResult } from "@/lib/api-operations/import-openapi";
import type { ApiOperation, ApiOperationRecord } from "@/types/schemas/api-operation";
import { importOpenApiOperationsAction, previewOpenApiOperationsAction, type OpenApiSource } from "@/app/(dashboard)/schemas/[domainSlug]/api-import-actions";

export interface ApiImportDialogProps {
  serviceId: string | null;
  domainId: string | null;
  entityId: string;
  entityName: string;
  onImported: (ops: ApiOperationRecord[]) => void;
}

type SourceTab = "paste" | "file" | "url";
/** Same cap as the server's (`MAX_IMPORT_CONTENT_BYTES`): a bigger file is refused here, before it is sent. */
const MAX_FILE_BYTES = 1024 * 1024;

const operationKey = (op: ApiOperation) => `${op.httpMethod} ${op.httpPath}`;
const typeLabel = (t: { type: string; isArray: boolean }) => `${t.type}${t.isArray ? "[]" : ""}`;

/**
 * "Import OpenAPI" for the entity API tab: a trigger button and its dialog. Paste a document, upload a file, or give an https URL
 * (fetched on the server with the importer's guards); the operations found are listed with checkboxes, the importer's warnings
 * beside them; Import creates the checked ones on the entity's API (created first when there is none) and hands the created records
 * to `onImported`. Swagger 2.0 and OpenAPI 3.0 are upgraded to 3.1 on the server.
 */
export function ApiImportDialog({ serviceId, domainId, entityId, entityName, onImported }: ApiImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SourceTab>("paste");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [found, setFound] = useState<OpenApiImportResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reset = useCallback(() => {
    setTab("paste");
    setContent("");
    setFileName(null);
    setUrl("");
    setError(null);
    setBusy(null);
    setFound(null);
    setSelected(new Set());
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) reset();
    },
    [reset]
  );

  const readFile = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`The file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB); the limit is 1 MB.`);
      return;
    }
    setContent(await file.text());
    setFileName(file.name);
  }, []);

  const source = useMemo<OpenApiSource | null>(
    () => (tab === "url" ? (url.trim() ? { kind: "url", url: url.trim() } : null) : content.trim() ? { kind: "text", content } : null),
    [tab, url, content]
  );

  const findOperations = useCallback(async () => {
    if (!source) return;
    setBusy("preview");
    setError(null);
    try {
      const result = await previewOpenApiOperationsAction(entityId, source);
      if (!result.success) {
        setError(result.error.suggestedFix ? `${result.error.message}. ${result.error.suggestedFix}` : result.error.message);
        return;
      }
      setFound(result.data);
      setSelected(new Set(result.data.operations.map(operationKey)));
    } catch {
      setError("The document could not be read. Try again.");
    } finally {
      setBusy(null);
    }
  }, [entityId, source]);

  const runImport = useCallback(async () => {
    if (!found) return;
    const operations = found.operations.filter((op) => selected.has(operationKey(op)));
    if (operations.length === 0) return;
    setBusy("import");
    setError(null);
    try {
      const result = await importOpenApiOperationsAction({ serviceId, domainId, entityId, entityName, operations });
      if (!result.success) {
        setError(result.error);
        return;
      }
      const n = result.created.length;
      if (n > 0) toast.success(`Imported ${n} operation${n === 1 ? "" : "s"}`);
      else toast.info("No new operations were imported");
      for (const w of result.warnings.slice(0, 3)) toast.warning(w);
      if (result.warnings.length > 3) toast.warning(`… and ${result.warnings.length - 3} more`);
      onImported(result.created);
      onOpenChange(false);
    } catch {
      setError("The import failed. Try again.");
    } finally {
      setBusy(null);
    }
  }, [found, selected, serviceId, domainId, entityId, entityName, onImported, onOpenChange]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = !!found && found.operations.length > 0 && selected.size === found.operations.length;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="api-import-open">
        <Upload className="w-3.5 h-3.5" />
        Import OpenAPI
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden" data-testid="api-import-dialog">
          <DialogHeader>
            <DialogTitle>Import OpenAPI operations</DialogTitle>
            <DialogDescription>
              {found
                ? `Choose the operations to add to ${entityName}'s API. Operations it already has (same method and path) are skipped.`
                : "Paste, upload or link a Swagger 2.0, OpenAPI 3.0 or 3.1 document (JSON or YAML)."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto flex flex-col gap-space-3">
            {error ? (
              <div role="alert" className="flex gap-space-2 rounded-lg border border-destructive/30 bg-destructive/10 p-space-3 text-caption text-destructive">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words">{error}</span>
              </div>
            ) : null}

            {!found ? (
              <>
                <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Document source">
                  {([
                    { id: "paste" as const, label: "Paste", icon: ClipboardPaste },
                    { id: "file" as const, label: "Upload file", icon: FileText },
                    { id: "url" as const, label: "From URL", icon: Link2 },
                  ]).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      onClick={() => setTab(t.id)}
                      className={`flex items-center gap-space-1 px-space-3 py-2 text-body-small border-b-2 transition-colors ${
                        tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <t.icon className="w-4 h-4" />
                      {t.label}
                    </button>
                  ))}
                </div>
                {tab === "paste" ? (
                  <Textarea
                    aria-label="OpenAPI document"
                    data-testid="api-import-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={'openapi: "3.1.0"\ninfo:\n  title: Orders\n  version: 1.0.0\npaths:\n  /orders: ...'}
                    className="min-h-64 max-h-[50vh] font-mono text-[13px]"
                    spellCheck={false}
                  />
                ) : null}
                {tab === "file" ? (
                  <div
                    className="flex flex-col items-center justify-center gap-space-2 rounded-xl border-2 border-dashed border-border p-space-6"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const file = e.dataTransfer.files?.[0];
                      if (file) void readFile(file);
                    }}
                  >
                    <Upload className="w-6 h-6 text-muted-foreground" />
                    <p className="text-body-small text-muted-foreground">{fileName ? `Loaded ${fileName}` : "Drop a .yaml, .yml or .json file here"}</p>
                    <label className="cursor-pointer rounded-lg bg-muted px-3 py-1 text-caption hover:bg-accent">
                      Browse
                      <input
                        type="file"
                        accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
                        className="hidden"
                        data-testid="api-import-file"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void readFile(file);
                        }}
                      />
                    </label>
                  </div>
                ) : null}
                {tab === "url" ? (
                  <div className="flex flex-col gap-space-1">
                    <Input
                      aria-label="OpenAPI document URL"
                      data-testid="api-import-url"
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://example.com/openapi.yaml"
                    />
                    <p className="text-caption text-muted-foreground">Fetched by the server over https; external $refs in the document are not followed.</p>
                  </div>
                ) : null}
              </>
            ) : (
              <ReviewList found={found} selected={selected} toggle={toggle} />
            )}
          </div>

          <DialogFooter>
            {found ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setFound(null)} disabled={busy !== null}>
                  Back
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy !== null || found.operations.length === 0}
                  onClick={() => setSelected(allSelected ? new Set() : new Set(found.operations.map(operationKey)))}
                >
                  {allSelected ? "Select none" : "Select all"}
                </Button>
                <Button type="button" onClick={runImport} disabled={busy !== null || selected.size === 0} data-testid="api-import-confirm">
                  {busy === "import" ? "Importing…" : `Import ${selected.size} operation${selected.size === 1 ? "" : "s"}`}
                </Button>
              </>
            ) : (
              <Button type="button" onClick={findOperations} disabled={busy !== null || !source} data-testid="api-import-preview">
                {busy === "preview" ? "Reading…" : "Find operations"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReviewList({ found, selected, toggle }: { found: OpenApiImportResult; selected: Set<string>; toggle: (key: string) => void }) {
  return (
    <div className="flex flex-col gap-space-3" data-testid="api-import-review">
      <p className="text-caption text-muted-foreground">
        {found.title ? `${found.title}${found.version ? ` ${found.version}` : ""} · ` : ""}
        {found.sourceVersion.startsWith("2") ? "Swagger" : "OpenAPI"} {found.sourceVersion} · {found.operations.length} operation
        {found.operations.length === 1 ? "" : "s"} found
      </p>
      {found.operations.length === 0 ? <p className="text-body-small">No operation in the document can be imported.</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {found.operations.map((op) => {
          const key = operationKey(op);
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-start gap-space-2 px-space-3 py-space-2 hover:bg-muted/40">
                <input type="checkbox" className="mt-1" checked={selected.has(key)} onChange={() => toggle(key)} aria-label={key} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-space-2 text-body-small">
                    <span className="inline-block min-w-14 rounded bg-muted px-1.5 py-0.5 text-center font-mono text-caption font-semibold">{op.httpMethod}</span>
                    <span className={`font-mono ${op.deprecated ? "line-through text-muted-foreground" : ""}`}>{op.httpPath}</span>
                    <span className="truncate text-muted-foreground">{op.name}</span>
                  </span>
                  <span className="text-caption text-muted-foreground truncate">
                    {[
                      op.summary,
                      op.requestBody ? `body ${typeLabel(op.requestBody)}` : "",
                      op.responses.length ? `responses ${op.responses.map((r) => (r.type ? `${r.statusCode} ${typeLabel({ type: r.type, isArray: r.isArray })}` : `${r.statusCode}`)).join(", ")}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {found.referencedTypes.length > 0 ? (
        <p className="text-caption text-muted-foreground">
          Refers to {found.referencedTypes.map((t) => <code key={t} className="mr-1 font-mono text-foreground">{t}</code>)}— these entities or data types must exist for the
          generated OpenAPI to resolve them.
        </p>
      ) : null}
      {found.warnings.length > 0 ? (
        <details className="rounded-md border border-border bg-muted/40 p-space-3 text-caption" data-testid="api-import-warnings">
          <summary className="flex cursor-pointer items-center gap-space-2 text-muted-foreground">
            <AlertTriangle className="w-3.5 h-3.5" />
            {found.warnings.length} warning{found.warnings.length === 1 ? "" : "s"}: what was not imported
          </summary>
          <ul className="mt-space-2 flex list-disc flex-col gap-1 pl-space-4">
            {found.warnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
