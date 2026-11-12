"use client";

import { useRef, useState } from "react";
import ArrowDown from "lucide-react/icons/arrow-down";
import ArrowUp from "lucide-react/icons/arrow-up";
import ChevronRight from "lucide-react/icons/chevron-right";
import GripVertical from "lucide-react/icons/grip-vertical";
import Plus from "lucide-react/icons/plus";
import Trash2 from "lucide-react/icons/trash-2";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { environmentBranchSlug } from "@/lib/deployments/git-branch";
import type { EnvironmentDefinition, EnvironmentDetails, EnvironmentWorkflowUsage } from "@/lib/deployments/contracts";
import { cn } from "@/lib/utils";

/** `original` is the saved name a row was loaded with; new rows have none. */
export type EnvironmentRow = EnvironmentDefinition & { key: string; original?: string };
let next = 0;
const key = () => `env-${++next}`;
export const toRows = (names: string[], details: EnvironmentDetails = {}): EnvironmentRow[] =>
  names.map((name) => ({ key: key(), name, original: name, description: details[name]?.description ?? "", branch: details[name]?.branch ?? "" }));
export const toDefinitions = (rows: EnvironmentRow[]): EnvironmentDefinition[] =>
  rows.map(({ name, description, branch }) => ({ name: name.trim(), description: description.trim(), ...(branch?.trim() ? { branch: branch.trim() } : {}) }));

/** Saved environments renamed in the draft (old → new). */
export function environmentRenames(rows: EnvironmentRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.original && r.name.trim() && r.name.trim() !== r.original).map((r) => [r.original!, r.name.trim()]));
}
/** Saved environments the draft no longer contains. */
export function removedEnvironments(saved: string[], rows: EnvironmentRow[]): string[] {
  const kept = new Set(rows.map((r) => r.original).filter(Boolean));
  return saved.filter((name) => !kept.has(name));
}
/** Default home for a removed environment's workflows: the nearest earlier stage still present, else the first stage. */
export function defaultReassignment(removed: string, saved: string[], rows: EnvironmentRow[]): string | null {
  const byOriginal = new Map(rows.filter((r) => r.original).map((r) => [r.original!, r.name.trim()]));
  for (let i = saved.indexOf(removed) - 1; i >= 0; i--) { const name = byOriginal.get(saved[i]); if (name) return name; }
  for (let i = saved.indexOf(removed) + 1; i < saved.length; i++) { const name = byOriginal.get(saved[i]); if (name) return name; }
  return rows.find((r) => r.name.trim())?.name.trim() ?? null;
}

/** Problems the server would also reject, shown before saving. */
export function environmentProblems(rows: EnvironmentRow[]): string[] {
  const problems: string[] = [];
  if (!rows.length) problems.push("Define at least one environment.");
  if (rows.some((r) => !r.name.trim())) problems.push("Name every environment.");
  const names = rows.map((r) => r.name.trim().toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) problems.push("Environment names must be unique.");
  return problems;
}

const move = <T,>(list: T[], from: number, to: number) => {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
};

/**
 * The tenant's promotion order, first to final. Rows are reordered by dragging the handle or with the
 * arrow buttons; each environment has an optional description and a Git branch override.
 */
export function EnvironmentPipelineEditor({ rows, onChange }: { rows: EnvironmentRow[]; onChange: (rows: EnvironmentRow[]) => void }) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const nameRefs = useRef(new Map<string, HTMLInputElement>());
  const update = (index: number, patch: Partial<EnvironmentRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  function add() {
    const row = { key: key(), name: "", description: "", branch: "" };
    onChange([...rows, row]);
    requestAnimationFrame(() => nameRefs.current.get(row.key)?.focus());
  }
  const last = rows.length - 1;
  return <div className="flex min-w-0 flex-col gap-3" data-testid="environment-pipeline">
    {rows.length > 1 && <ol aria-label="Promotion order" className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {rows.map((r, i) => <li key={r.key} className="flex items-center gap-1"><Badge variant={i === last ? "default" : "outline"}>{r.name.trim() || "unnamed"}</Badge>{i < last && <ChevronRight aria-hidden="true" className="size-3" />}</li>)}
    </ol>}
    <div aria-hidden="true" className="hidden grid-cols-[auto_2rem_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_auto] gap-2 px-2 text-xs font-medium text-muted-foreground sm:grid"><span className="w-4" /><span /><span>Environment</span><span>Description</span><span>Git base branch</span><span className="w-24" /></div>
    <ol className="flex min-w-0 flex-col gap-2">
      {rows.map((row, i) => {
        const label = row.name.trim() || `environment ${i + 1}`;
        return <li
          key={row.key}
          data-testid="environment-row"
          onDragOver={(e) => { if (dragging === null) return; e.preventDefault(); setOver(i); }}
          onDrop={(e) => { e.preventDefault(); if (dragging !== null && dragging !== i) onChange(move(rows, dragging, i)); setDragging(null); setOver(null); }}
          className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-border bg-card p-2 sm:grid-cols-[auto_2rem_minmax(0,0.8fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_auto]", over === i && dragging !== i && "border-primary", dragging === i && "opacity-50")}
        >
          <span
            draggable
            onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            className="flex h-9 cursor-grab items-center text-muted-foreground active:cursor-grabbing"
            aria-hidden="true"
            title="Drag to reorder"
          ><GripVertical className="size-4" /></span>
          <span className="hidden h-9 items-center justify-center text-xs font-medium text-muted-foreground tabular-nums sm:flex" aria-hidden="true">{i + 1}</span>
          <div className="flex min-w-0 flex-col gap-1">
            <Input ref={(el) => { if (el) nameRefs.current.set(row.key, el); else nameRefs.current.delete(row.key); }} aria-label={`Environment ${i + 1} name`} value={row.name} placeholder={i === 0 ? "development" : "name"} onChange={(e) => update(i, { name: e.target.value })} />
            <span className="text-[11px] text-muted-foreground">{i === 0 ? "First stage" : i === last ? "Final stage" : `Stage ${i + 1}`}</span>
          </div>
          <Input className="col-span-3 sm:col-span-1" aria-label={`${label} description`} value={row.description} placeholder="What this environment is for" onChange={(e) => update(i, { description: e.target.value })} />
          <Input className="col-span-2 font-mono sm:col-span-1" aria-label={`${label} Git branch`} value={row.branch ?? ""} placeholder={environmentBranchSlug(row.name || "branch")} spellCheck={false} onChange={(e) => update(i, { branch: e.target.value })} />
          <div className="flex items-center justify-end gap-0.5">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${label} earlier`} disabled={i === 0} onClick={() => onChange(move(rows, i, i - 1))}><ArrowUp /></Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${label} later`} disabled={i === last} onClick={() => onChange(move(rows, i, i + 1))}><ArrowDown /></Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${label}`} disabled={rows.length === 1} onClick={() => onChange(rows.filter((_, idx) => idx !== i))}><Trash2 /></Button>
          </div>
        </li>;
      })}
    </ol>
    <Button type="button" variant="outline" size="sm" className="self-start" onClick={add}><Plus data-icon="inline-start" />Add environment</Button>
  </div>;
}

/**
 * What saving does to active workflows: renamed environments carry theirs along; a removed environment's workflows move to
 * the chosen environment (defaulting to the neighbouring stage) or are disabled.
 */
export function EnvironmentWorkflowChanges({ saved, rows, usage, reassign, onReassign }: {
  saved: string[]; rows: EnvironmentRow[]; usage: Record<string, EnvironmentWorkflowUsage[]>;
  reassign: Record<string, string | null>; onReassign: (removed: string, to: string | null) => void;
}) {
  const renames = Object.entries(environmentRenames(rows)).filter(([from]) => usage[from]?.length);
  const removed = removedEnvironments(saved, rows).filter((name) => usage[name]?.length);
  if (!renames.length && !removed.length) return null;
  const targets = rows.map((r) => r.name.trim()).filter(Boolean);
  const list = (items: EnvironmentWorkflowUsage[]) => <ul className="flex flex-col gap-1 pl-1">{items.map((w) => <li key={w.id} className="text-xs text-muted-foreground">{w.href ? <a href={w.href} className="text-foreground underline-offset-2 hover:underline">{w.name}</a> : <span className="text-foreground">{w.name}</span>} · {w.scope}</li>)}</ul>;
  return <section aria-label="Workflow changes on save" data-testid="environment-workflow-changes" className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-muted/20 p-3">
    <h3 className="text-sm font-medium">Workflows updated when you save</h3>
    {renames.map(([from, to]) => <div key={from} className="flex flex-col gap-1">
      <p className="text-sm">{usage[from].length} {usage[from].length === 1 ? "workflow follows" : "workflows follow"} the rename <span className="font-mono">{from}</span> → <span className="font-mono">{to}</span></p>
      {list(usage[from])}
    </div>)}
    {removed.map((name) => {
      const choice = name in reassign ? reassign[name] : defaultReassignment(name, saved, rows);
      return <div key={name} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span><span className="font-mono">{name}</span> is removed. Its {usage[name].length === 1 ? "workflow" : `${usage[name].length} workflows`}:</span>
          <select aria-label={`Workflows of ${name}`} className="h-8 rounded-md border border-input bg-background px-2 text-sm" value={choice ?? "__disable"} onChange={(e) => onReassign(name, e.target.value === "__disable" ? null : e.target.value)}>
            {targets.map((t) => <option key={t} value={t}>Move to {t}</option>)}
            <option value="__disable">Disable</option>
          </select>
        </div>
        {list(usage[name])}
      </div>;
    })}
  </section>;
}
