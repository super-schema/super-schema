import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeploymentWorkspace } from "@/lib/deployments/contracts";
import { targetLabel } from "./DeploymentFields";

export function TargetVersionMatrix({ data }: { data: DeploymentWorkspace }) {
  const environments = [...new Set([...data.environments, ...data.recorded.map((r) => r.environment)])];
  const targets = [...new Set([...data.formats.map((f) => f.key), ...data.recorded.map((r) => r.target)])];
  return <section aria-labelledby="target-versions-heading" className="min-w-0 rounded-lg border border-border" data-testid="target-version-matrix">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><h3 id="target-versions-heading" className="text-sm font-semibold">Target versions</h3><span className="text-xs text-muted-foreground">Recorded deployment state</span></div>
    <Table>
      <TableCaption className="px-4 pb-3 text-left text-xs">Versions are numbered per target. Source v refers to the entity version used to generate that artifact. Delivery receipts appear in each workflow tab.</TableCaption>
      <TableHeader><TableRow><TableHead>Target datastore or format</TableHead><TableHead>Latest published</TableHead>{environments.map((e) => <TableHead key={e}>{e}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{targets.length ? targets.map((key) => {
        const target = data.formats.find((f) => f.key === key);
        const latest = target?.versions[0];
        const source = latest ? target?.sourceVersions?.[String(latest)] : undefined;
        return <TableRow key={key}><TableCell className="font-medium">{targetLabel(key)}</TableCell><TableCell>{latest ? <div className="flex flex-col items-start gap-1"><Badge variant="secondary">v{latest}</Badge>{source !== undefined && <span className="text-xs text-muted-foreground">Source v{source}</span>}</div> : <span className="text-muted-foreground">Unpublished</span>}</TableCell>{environments.map((environment) => {
          const record = data.recorded.find((r) => r.target === key && r.environment === environment);
          return <TableCell key={environment}>{record ? <div className="flex flex-col items-start gap-1"><Badge variant={record.version === latest ? "success" : "warning"}>v{record.version}</Badge><span className="text-xs text-muted-foreground">{record.sourceVersion !== null ? `Source v${record.sourceVersion}` : "Source unknown"}{record.version !== latest ? " · differs" : ""}</span></div> : <span className="text-muted-foreground" aria-label="No recorded deployment">—</span>}</TableCell>;
        })}</TableRow>;
      }) : <TableRow><TableCell colSpan={environments.length + 2} className="text-muted-foreground">Generate a target schema to begin comparing versions.</TableCell></TableRow>}</TableBody>
    </Table>
  </section>;
}
