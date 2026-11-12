"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Copy from "lucide-react/icons/copy";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fileDiff } from "@/lib/deployments/file-diff";
import type { PreparedPlan } from "@/lib/deployments/contracts";

const DetailPanel = dynamic(() => import("@/components/custom/SchemaWorkbench/DetailPanel").then((module) => module.DetailPanel), { loading: () => <p role="status" className="p-4 text-sm text-muted-foreground">Loading file content…</p> });
const unchanged = () => undefined;
const fileFormat = (path: string) => /\.sql$/i.test(path) ? "bigquery-ddl" : /\.proto$/i.test(path) ? "protobuf" : /\.tsp$/i.test(path) ? "typespec" : undefined;

export function GitPrPreview({ plan }: { plan: PreparedPlan }) {
  const files = plan.files ?? [];
  const [path, setPath] = useState(() => plan.fileChanges?.find((f) => f.status !== "unchanged")?.path ?? files[0]?.path ?? "");
  const selected = files.find((file) => file.path === path) ?? files[0];
  const change = plan.fileChanges?.find((file) => file.path === selected?.path);
  const diff = useMemo(() => selected && change ? fileDiff(change.before ?? "", selected.content) : null, [selected, change]);
  const count = plan.fileChanges?.filter((file) => file.status !== "unchanged").length;
  return <div className="flex min-w-0 flex-col gap-4" data-testid="git-pr-preview">
    <div className="flex min-w-0 flex-col gap-2"><p className="break-words text-sm font-medium" data-testid="git-preview-title">{plan.settings.title}</p><p className="break-all text-sm text-muted-foreground">{plan.connectionConfig.url}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{plan.connectionConfig.baseBranch}</Badge><span>←</span><span className="break-all font-mono">{plan.branch}</span><span>Base {plan.baseSha?.slice(0, 12)}</span><span>{files.length} files{count !== undefined ? ` · ${count} changed` : ""}</span></div>
    </div>
    {!files.length ? <p role="alert" className="text-sm text-destructive">The Git preview has no prepared files. Validate the workflow again.</p> : <div className="grid min-w-0 overflow-hidden rounded-lg border border-border lg:grid-cols-[minmax(14rem,0.35fr)_minmax(0,1fr)]">
      <nav aria-label="Files in Git PR" className="min-w-0 border-b border-border bg-muted/15 p-2 lg:border-r lg:border-b-0"><ul className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto">{files.map((file) => {
        const status = plan.fileChanges?.find((entry) => entry.path === file.path)?.status;
        return <li key={file.path}><Button variant={file.path === selected?.path ? "outline" : "ghost"} className="h-auto w-full min-w-0 justify-start py-2 whitespace-normal" aria-current={file.path === selected?.path ? "true" : undefined} onClick={() => setPath(file.path)}><span className="flex min-w-0 flex-1 flex-col items-start gap-1"><span className="break-all text-left font-mono text-xs">{file.path}</span><Badge variant={status === "added" ? "success" : status === "modified" ? "warning" : "outline"}>{status ?? "planned"}</Badge></span></Button></li>;
      })}</ul></nav>
      {selected && <div className="flex min-w-0 flex-col gap-3 p-3">
        <div className="flex min-w-0 items-start justify-between gap-2"><p className="min-w-0 break-all font-mono text-xs" data-testid="git-selected-path">{selected.path}</p><Button variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(selected.content); toast.success("File content copied"); } catch { toast.error("Could not copy file content"); } }}><Copy data-icon="inline-start" />Copy</Button></div>
        <Tabs defaultValue="content" className="min-w-0"><TabsList variant="line" aria-label="File preview"><TabsTrigger value="content">Content</TabsTrigger><TabsTrigger value="changes" disabled={!change}>Changes</TabsTrigger></TabsList>
          <TabsContent value="content"><DetailPanel key={selected.path} label="Proposed file content" value={selected.content} onChange={unchanged} readOnly format={fileFormat(selected.path)} /></TabsContent>
          <TabsContent value="changes" className="min-w-0">
            {change && diff ? <>
              <div className="max-h-[32rem] min-w-0 overflow-auto rounded-md border border-border" data-testid="git-file-diff"><table className="w-full border-collapse font-mono text-xs"><tbody>{diff.slice(0, 2000).map((line, index) => <tr key={index} className={cn(line.kind === "added" && "bg-success/10", line.kind === "removed" && "bg-destructive/10")}><td className="w-10 px-2 text-right text-muted-foreground select-none">{line.oldLine}</td><td className="w-10 px-2 text-right text-muted-foreground select-none">{line.newLine}</td><td className="w-4 text-center select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</td><td><pre className="whitespace-pre px-2">{line.text || " "}</pre></td></tr>)}</tbody></table></div>
              {diff.length > 2000 && <p className="mt-2 text-xs text-muted-foreground">Showing the first 2,000 diff lines. Content contains the complete proposed file.</p>}
              {change.status === "modified" && !diff.some((line) => line.kind !== "context") && <p className="mt-2 text-xs text-muted-foreground">The final newline changed. Content and Copy preserve the exact proposed file.</p>}
            </> : <p className="text-sm text-muted-foreground">This file is too large for an inline diff. Content contains the complete proposed file.</p>}
          </TabsContent>
        </Tabs>
      </div>}
    </div>}
    {count === 0 && <p role="status" className="text-sm text-muted-foreground">No file changes against the selected base commit.</p>}
    <details><summary className="cursor-pointer text-sm text-muted-foreground">Validation details</summary><ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">{plan.validation.map((entry) => <li key={entry}>{entry}</li>)}</ul></details>
  </div>;
}
