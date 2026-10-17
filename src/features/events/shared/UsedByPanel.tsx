// src/features/events/shared/UsedByPanel.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { listUsagesAction } from "@/app/(dashboard)/schemas/usage-actions";
import type { UsageList, UsageSubject } from "@/lib/events/usage";

type Outcome = { status: "error"; message: string } | { status: "ready"; list: UsageList };

const LOAD_FAILED = "Could not load usages. Try again.";

/** A subject as two primitives (kind, id): stable effect dependencies, rebuilt into the action's input by `subjectOf`. */
interface SubjectParts {
  kind: UsageSubject["kind"];
  id: string;
}
/** Exhaustive over the subject kinds: a new kind is a compile error here until it is handled (and in `subjectOf`). */
function partsOf(subject: UsageSubject): SubjectParts {
  switch (subject.kind) {
    case "event":
      return { kind: "event", id: subject.eventId };
    case "entity":
      return { kind: "entity", id: subject.entityId };
    default:
      return subject satisfies never;
  }
}
function subjectOf({ kind, id }: SubjectParts): UsageSubject {
  switch (kind) {
    case "event":
      return { kind, eventId: id };
    case "entity":
      return { kind, entityId: id };
    default:
      return kind satisfies never;
  }
}

/** Spec 18.9 "Who uses X?" — published uses first, drafts flagged, deleted referrers shown as plain text. The subject is an entity or an event. */
export function UsedByPanel({
  subject, title = "Used by", emptyText = "Nothing references this yet.",
}: { subject: UsageSubject; title?: string; emptyText?: string }) {
  const { kind, id } = partsOf(subject);
  const key = `${kind}:${id}`;
  // The outcome is keyed by subject: a result for a previous subject counts as "still loading" for the new one.
  const [result, setResult] = useState<{ key: string; outcome: Outcome } | null>(null);
  const outcome = result?.key === key ? result.outcome : null;

  useEffect(() => {
    let cancelled = false;
    const current = subjectOf({ kind, id });
    const settle = (next: Outcome) => {
      if (!cancelled) setResult({ key, outcome: next });
    };
    void (async () => {
      try {
        const r = await listUsagesAction(current);
        settle(r.success ? { status: "ready", list: r.data } : { status: "error", message: r.error });
      } catch {
        // A rejected / throwing action must end the loading state (the action's own errors are already generic).
        settle({ status: "error", message: LOAD_FAILED });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, id, key]);

  const rows = outcome?.status === "ready" ? outcome.list.rows : [];
  return (
    <section className="space-y-space-2" data-testid="used-by-panel">
      <h3 className="text-heading-3 text-foreground">{title}</h3>
      {outcome === null && (
        <p className="flex items-center gap-2 text-body-small text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Looking up references…</p>
      )}
      {outcome?.status === "error" && <p role="alert" className="text-body-small text-destructive">{outcome.message}</p>}
      {outcome?.status === "ready" && rows.length === 0 && <p className="text-body-small text-muted-foreground">{emptyText}</p>}
      {rows.length > 0 && (
        <ul className="space-y-space-1">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-space-2 text-body-small">
              {row.href ? <Link href={row.href} className="text-primary hover:underline">{row.label}</Link> : <span className="text-muted-foreground">{row.label}</span>}
              <Badge variant="secondary">{row.role}</Badge>
              {row.isDraft && <Badge variant="outline">draft</Badge>}
              <span className="text-caption text-muted-foreground">→ {row.target}</span>
            </li>
          ))}
        </ul>
      )}
      {outcome?.status === "ready" && outcome.list.truncated && (
        // The scan limit can cut the list short of USAGE_ROW_LIMIT, so the text counts the rows that are shown.
        <p data-testid="used-by-truncated" className="text-caption text-muted-foreground">
          {rows.length === 1 ? "Showing the first reference." : `Showing the first ${rows.length} references.`}
        </p>
      )}
    </section>
  );
}
