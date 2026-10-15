import { Badge } from "@/components/ui/badge";
import type { Diagnostic, DiagnosticSeverity } from "@/lib/event-specs/types";

const VARIANT = { error: "destructive", warning: "secondary", info: "outline" } as const;
const ORDER: DiagnosticSeverity[] = ["error", "warning", "info"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function DiagnosticsList({ diagnostics, unpublishedMessages }: { diagnostics: Diagnostic[]; unpublishedMessages: Array<{ id: string; name: string }> }) {
  const count = (severity: DiagnosticSeverity) => diagnostics.filter((d) => d.severity === severity).length;
  const infos = count("info");
  const summary = [plural(count("error"), "error"), plural(count("warning"), "warning"), ...(infos > 0 ? [`${infos} info`] : [])].join(" · ");
  // Stable: errors first, then warnings, then info; each group keeps the emitter's order.
  const sorted = ORDER.flatMap((severity) => diagnostics.filter((d) => d.severity === severity));
  return (
    <div className="space-y-space-3" data-testid="diagnostics-list">
      {unpublishedMessages.map((m) => (
        <p key={m.id} className="text-body-small text-muted-foreground">{`Message ${m.name} is an unpublished draft (preview only) — publish it and pick its version before publishing this spec.`}</p>
      ))}
      {diagnostics.length === 0 ? (
        <p className="text-body-small text-muted-foreground">No problems found — the document validates with @asyncapi/parser.</p>
      ) : (
        <>
          <p className="text-body-small text-foreground">{summary}</p>
          <ul className="space-y-space-2">
            {sorted.map((d, i) => (
              <li key={`${d.code}-${d.pointer}-${i}`} className="rounded-md border border-border/50 p-space-3">
                <div className="flex flex-wrap items-center gap-space-2">
                  <Badge variant={VARIANT[d.severity]}>{d.severity}</Badge>
                  <span className="font-mono text-caption">{d.code}</span>
                  {d.pointer && <span className="font-mono text-caption text-muted-foreground">{d.pointer}</span>}
                </div>
                <p className="mt-space-1 text-body-small text-foreground">{d.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
