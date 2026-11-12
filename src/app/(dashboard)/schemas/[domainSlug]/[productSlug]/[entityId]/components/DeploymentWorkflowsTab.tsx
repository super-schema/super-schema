"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ArrowUpRight from "lucide-react/icons/arrow-up-right";
import Loader2 from "lucide-react/icons/loader-circle";
import RefreshCw from "lucide-react/icons/refresh-cw";
import Send from "lucide-react/icons/send";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deploymentMethodsFor } from "@/lib/deployments/target-methods";
import { generatedGitPrTitle } from "@/lib/deployments/pr-title";
import { gitBranchForEnvironment } from "@/lib/deployments/git-branch";
import { Input } from "@/components/ui/input";
import { GitPrPreview } from "@/components/custom/deployments/GitPrPreview";
import { WorkflowSettingsSchema, workflowTargets, type DeploymentMethod, type DeploymentWorkspace, type PreparedPlan, type RunView, type WorkflowSettings } from "@/lib/deployments/contracts";
import { DeploymentField as Field, DeploymentChoice as Choice, DEPLOYMENT_METHODS, targetOptions, deploymentVariables, WorkflowVariablesFields } from "@/components/custom/deployments/DeploymentFields";
import { TargetVersionMatrix } from "@/components/custom/deployments/TargetVersionMatrix";
import { getDeploymentWorkspaceAction, previewDeploymentAction, executeDeploymentAction, refreshDeploymentReceiptAction } from "../deployment-actions";
import { EntityDeploymentsTab } from "./EntityDeploymentsTab";

type DeploymentWorkflowsTabProps = { entityId: string; entityName: string; initialFormat?: string; initialVersion?: string };
export function DeploymentWorkflowsTab(props: DeploymentWorkflowsTabProps) {
  return <DeploymentWorkflowEditor key={JSON.stringify([props.entityId, props.initialFormat, props.initialVersion])} {...props} />;
}
function DeploymentWorkflowEditor({ entityId, entityName, initialFormat = "", initialVersion = "" }: DeploymentWorkflowsTabProps) {
  const [data, setData] = useState<DeploymentWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preferredMethod, setPreferredMethod] = useState<DeploymentMethod>("git");
  const [format, setFormat] = useState(initialFormat);
  const [version, setVersion] = useState(initialVersion);
  const [refresh, setRefresh] = useState(0);
  const load = useCallback(async () => { const r = await getDeploymentWorkspaceAction(entityId); if ("error" in r) throw new Error(r.error); setData(r.data); setError(null); setFormat((current) => current || r.data.formats[0]?.key || ""); setVersion((current) => current || r.data.formats.find((f) => f.key === (initialFormat || r.data.formats[0]?.key))?.versions[0]?.toString() || ""); }, [entityId, initialFormat]);
  useEffect(() => {
    // Loading updates state only after the server action resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  const pending = data?.runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { void load().catch(() => undefined); }, 3000); return () => clearInterval(timer); }, [pending, load]);
  const allowedMethods = deploymentMethodsFor(format, data?.targetMethods);
  const method = allowedMethods.includes(preferredMethod) ? preferredMethod : allowedMethods[0];
  const versions = data?.formats.find((f) => f.key === format)?.versions ?? [];
  return <div className="flex min-w-0 flex-col gap-5" data-testid="deployment-workflows-tab">
    <div className="flex items-start justify-between gap-3"><p className="min-w-0 flex-1 text-sm text-muted-foreground">Choose a published target and a product workflow to deliver this schema.</p><div className="flex shrink-0 flex-wrap justify-end gap-2">{data?.canConfigure && <Link href="/admin/workflows/connections" className="self-center text-sm text-primary underline">Deployment settings</Link>}<Button size="sm" variant="outline" disabled={busy} onClick={() => { setBusy(true); setRefresh((n) => n + 1); void load().catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}><RefreshCw data-icon="inline-start" />Refresh</Button></div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? (error ? null : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading workflows…</p>) : <>
      <TargetVersionMatrix data={data} />
      <FieldGroup className="grid sm:grid-cols-2"><Field id="deployment-format" label="Target datastore or format"><Choice id="deployment-format" value={format} options={targetOptions()} onChange={(v) => { setFormat(v); setVersion(data.formats.find((f) => f.key === v)?.versions[0]?.toString() ?? ""); }} /></Field><Field id="deployment-version" label="Published artifact version"><Choice id="deployment-version" value={version} options={versions.map((v) => ({ value: String(v), label: `v${v}` }))} onChange={setVersion} /></Field></FieldGroup>
      <Tabs value={method} onValueChange={(v) => setPreferredMethod(v as DeploymentMethod)} className="min-w-0">
        <div className="min-w-0 overflow-x-auto p-1"><TabsList variant="line" aria-label="Deployment methods">{DEPLOYMENT_METHODS.filter((m) => allowedMethods.includes(m.value)).map((m) => <TabsTrigger key={m.value} value={m.value} className="shrink-0 px-4">{m.label}</TabsTrigger>)}</TabsList></div>
        {DEPLOYMENT_METHODS.filter((m) => allowedMethods.includes(m.value)).map((m) => <TabsContent key={m.value} value={m.value} className="min-w-0">{method === m.value && <MethodDeployment key={`${m.value}:${format}:${version}:${refresh}`} entityId={entityId} method={m.value} format={format} version={version} data={data} load={load} />}</TabsContent>)}
      </Tabs>
      <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Record an environment deployment or compare stored output</summary>
        {!!data.legacyMarkers?.length && <p className="mt-3 text-sm text-muted-foreground">Legacy markers (environment unknown): {data.legacyMarkers.map((m) => `${m.format} v${m.version}`).join(", ")}</p>}
        <div className="mt-4"><EntityDeploymentsTab entityId={entityId} entityName={entityName} environments={data.environments} publishedVersions={data.formats} onRecorded={load} /></div>
      </details>
    </>}
  </div>;
}

function MethodDeployment({ entityId, method, format, version, data, load }: { entityId: string; method: DeploymentMethod; format: string; version: string; data: DeploymentWorkspace; load: () => Promise<void> }) {
  const [workflowId, setWorkflowId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [environment, setEnvironment] = useState(data.environments[0] ?? "");
  const [settings, setSettings] = useState<WorkflowSettings>(() => WorkflowSettingsSchema.parse({}));
  const [titleEdited, setTitleEdited] = useState(false);
  const [baseBranchOverride, setBaseBranchOverride] = useState("");
  const [referenceJson, setReferenceJson] = useState("{}");
  const [preview, setPreview] = useState<{ run: RunView; plan: PreparedPlan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => () => { revision.current += 1; }, []);
  const invalidate = () => { revision.current += 1; setPreview(null); };
  const connections = data.connections.filter((c) => c.method === method && c.active);
  const workflows = data.workflows.filter((w) => w.active && workflowTargets(w).includes(format) && data.connections.find((c) => c.id === w.connectionId)?.method === method);
  const workflow = workflows.find((w) => w.id === workflowId);
  const availableVersions = data.formats.find((f) => f.key === format)?.versions ?? [];
  const selectedAvailable = availableVersions.includes(Number(version));
  const runs = data.runs.filter((r) => r.method === method);
  function chooseWorkflow(id: string) {
    invalidate(); setWorkflowId(id); setBaseBranchOverride("");
    const w = workflows.find((w) => w.id === id);
    setTitleEdited(!!w?.settings.title.trim());
    setConnectionId(w?.connectionId ?? ""); setEnvironment(w?.environment ?? data.environments[0] ?? ""); setSettings(w?.settings ?? WorkflowSettingsSchema.parse({})); setReferenceJson(JSON.stringify(w?.settings.referenceSubjects ?? {}, null, 2));
  }
  async function action(label: string, work: () => Promise<void>) { setBusy(label); setError(null); try { await work(); } catch(e) { setError(e instanceof Error ? e.message : "Deployment request failed"); } finally { setBusy(null); } }
  const generatedTitle = generatedGitPrTitle({ schema: data.entitySlug ?? entityId, format, version, environment, contractVersion: settings.contractVersion });
  const effectiveSettings = method === "git" && !titleEdited ? { ...settings, title: generatedTitle } : settings;
  const selectedConnection = data.connections.find((c) => c.id === (method === "git" ? workflow?.connectionId : connectionId));
  const gitTarget = method === "git" && workflow ? data.gitDestinations?.[workflow.id]?.[environment] ?? (selectedConnection ? (() => { const r = gitBranchForEnvironment(data.environmentDetails, environment); return { url: selectedConnection.config.url, branch: r.branch, gitRoot: selectedConnection.config.gitRoot, source: r.overridden ? "environment-override" as const : "environment-name" as const }; })() : undefined) : undefined;
  const effectiveBaseBranch = baseBranchOverride.trim() || gitTarget?.branch || "";
  async function prepare() {
    const ticket = ++revision.current;
    const variables = deploymentVariables({ ...effectiveSettings, referenceSubjects: JSON.parse(referenceJson) });
    const r = await previewDeploymentAction(entityId, { workflowId, format, version: Number(version), environment, ...(method === "git" ? (baseBranchOverride.trim() && baseBranchOverride.trim() !== gitTarget?.branch ? { baseBranch: baseBranchOverride.trim() } : {}) : { connectionId }), variables, idempotencyKey: crypto.randomUUID() });
    if (ticket !== revision.current) return;
    if ("error" in r) throw new Error(r.error);
    setPreview(r.data); await load();
  }
  async function execute(run: RunView) {
    const r = await executeDeploymentAction(entityId, { runId: run.id, planHash: run.planHash });
    if ("error" in r) throw new Error(r.error);
    setPreview(null); await load(); toast.success(r.data.status === "QUEUED" ? "Delivery queued" : `Delivery ${r.data.status.toLowerCase()}`);
  }
  return <div className="flex min-w-0 flex-col gap-4 pt-3" data-testid={`deployment-method-${method}`}>
    <p className="text-sm text-muted-foreground">{method === "git" ? "Create a reviewable GitHub PR containing the selected schema artifacts. The repository owns merge and release." : method === "http" ? "Send the selected artifact files in a JSON envelope. The receiving API owns all subsequent processing." : "Register Avro, JSON Schema or Protobuf with a configured Confluent-compatible registry."}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <fieldset disabled={!!busy || !data.canRun} className="flex min-w-0 flex-col gap-4">

      {!selectedAvailable && <p className="text-sm text-muted-foreground">Publish this target version in Schemas before delivery. An unavailable selected version is never replaced silently.</p>}
      <FieldGroup className="grid sm:grid-cols-[1fr_auto]"><Field id="deployment-workflow" label="Saved workflow"><Choice id="deployment-workflow" value={workflowId} options={workflows.map((w) => ({ value: w.id, label: w.name + (w.scope === "schema" ? " (schema workflow)" : "") }))} onChange={chooseWorkflow} placeholder="Select a product workflow" /></Field>{data.productWorkflowsHref && <Link href={data.productWorkflowsHref} className="self-end rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent">New workflow</Link>}</FieldGroup>
      {!workflows.length && <p className="text-sm text-muted-foreground">No active {DEPLOYMENT_METHODS.find((m) => m.value === method)?.label} workflows for this target. Define one at product level, then refresh this page.</p>}
      <FieldGroup className="grid sm:grid-cols-2"><Field id="workflow-environment" label="Environment"><Choice id="workflow-environment" value={environment} options={data.environments.map((value) => ({ value, label: value }))} onChange={(v) => { invalidate(); setEnvironment(v); setBaseBranchOverride(""); }} /></Field>{method === "git" ? <div className="flex min-w-0 flex-col gap-1.5" data-testid="inherited-git-repository"><span className="text-sm font-medium">Git repository</span><div className="flex min-w-0 flex-col gap-1 rounded-md border border-border bg-muted/15 px-3 py-2"><p className="text-sm">{selectedConnection?.name ?? "Inherited from the selected workflow"}</p>{gitTarget && <><p className="break-all text-xs text-muted-foreground">{gitTarget.url}</p>{gitTarget.gitRoot && <p className="break-all text-xs text-muted-foreground">Root <span className="font-mono">{gitTarget.gitRoot}/</span></p>}</>}</div></div> : <Field id="workflow-connection" label={method === "registry" ? "Schema registry" : "API endpoint"}><Choice id="workflow-connection" value={connectionId} options={connections.map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => { invalidate(); setConnectionId(v); }} /></Field>}</FieldGroup>
      {method === "git" && gitTarget && <FieldGroup className="grid sm:grid-cols-2"><div className="flex min-w-0 flex-col gap-1.5"><label htmlFor="deployment-base-branch" className="text-sm font-medium">Base branch</label><div className="flex min-w-0 gap-2"><Input id="deployment-base-branch" className="font-mono" spellCheck={false} value={effectiveBaseBranch} disabled={gitTarget.source === "gitops-stage"} onChange={(e) => { invalidate(); setBaseBranchOverride(e.target.value); }} />{baseBranchOverride.trim() && baseBranchOverride.trim() !== gitTarget.branch && <Button type="button" variant="ghost" size="sm" onClick={() => { invalidate(); setBaseBranchOverride(""); }}>Reset</Button>}</div><p className="text-xs text-muted-foreground" data-testid="git-branch-source">{gitTarget.source === "gitops-stage" ? `GitOps stage branch for ${environment}.` : baseBranchOverride.trim() && baseBranchOverride.trim() !== gitTarget.branch ? `Overrides ${gitTarget.branch} for this PR only.` : gitTarget.source === "environment-override" ? `Configured branch for ${environment}.` : `Named after ${environment}. Set another branch in deployment settings.`}</p></div></FieldGroup>}
      {workflow && <fieldset className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4"><legend className="px-1 text-sm font-medium">Workflow variables</legend><WorkflowVariablesFields method={method} settings={effectiveSettings} generatedTitle={method === "git" ? generatedTitle : undefined} onResetTitle={() => { invalidate(); setTitleEdited(false); }} onChange={(s) => { invalidate(); if (s.title !== effectiveSettings.title) setTitleEdited(!!s.title.trim()); setSettings(s); }} referenceJson={referenceJson} onReferenceChange={(s) => { invalidate(); setReferenceJson(s); }} /></fieldset>}
      <Button className="self-end" disabled={!workflow || !selectedAvailable || !connections.some((c) => c.id === connectionId) || !data.environments.includes(environment) || !deploymentMethodsFor(format, data.targetMethods).includes(method)} onClick={() => void action("preview", prepare)}>{busy === "preview" && <Loader2 className="animate-spin" data-icon="inline-start" />}Validate and preview</Button>
    </fieldset>
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open && !busy) setPreview(null); }}>
        {preview && <DialogContent className="sm:max-w-5xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden" data-testid="deployment-preview">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">Review {preview.run.method === "git" ? "Git PR" : preview.run.method === "registry" ? "schema registration" : "API delivery"}<Badge variant="info">{preview.run.environment}</Badge></DialogTitle>
            <DialogDescription>Validated against the pinned destination. Nothing is written until you confirm.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 overflow-y-auto">
            {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
            {preview.run.method === "git" ? <GitPrPreview key={preview.run.id} plan={preview.plan} /> : <div className="flex min-w-0 flex-col gap-3">
              <h3 className="text-sm font-semibold">{preview.plan.bundle.format} v{preview.plan.bundle.version}</h3>
              <p className="break-all text-xs text-muted-foreground">{preview.plan.bundle.contentHash}</p>
              <p className="break-all text-sm">Destination: {preview.plan.connectionConfig.url}</p>
              <ul className="list-inside list-disc text-sm text-muted-foreground">{preview.plan.validation.map((v) => <li key={v}>{v}</li>)}</ul>
              <div className="max-h-96 overflow-auto rounded-md bg-muted/30 p-3"><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(preview.plan.files ?? { destination: preview.plan.connectionConfig.url, artifact: preview.plan.bundle }, null, 2)}</pre></div>
            </div>}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setPreview(null)}>Cancel</Button>
            <Button disabled={!!busy || !data.canRun || (preview.run.method === "git" && preview.plan.fileChanges?.every((file) => file.status === "unchanged"))} data-testid="deployment-execute" onClick={() => void action("execute", () => execute(preview.run))}>{busy === "execute" ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Send data-icon="inline-start" />}{preview.run.method === "git" ? "Create Git PR" : preview.run.method === "registry" ? "Register schema" : "Send to API"}</Button>
          </DialogFooter>
        </DialogContent>}
      </Dialog>
      <section className="flex min-w-0 flex-col gap-3" aria-label="Delivery history"><h3 className="text-sm font-semibold">Delivery history</h3>
        {!runs.length && <p className="text-sm text-muted-foreground">No delivery runs yet. Select a product workflow, validate it, then execute the preview.</p>}
        <div className="flex flex-col gap-2">{runs.map((run) => <div key={run.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3" data-testid="deployment-run">
          <span className="text-sm font-medium">{DEPLOYMENT_METHODS.find((m) => m.value === run.method)?.label} · {run.format} v{run.artifactVersion}</span><span className="text-sm text-muted-foreground">{run.environment}</span>
          <Badge variant={run.status === "SUCCEEDED" ? "success" : run.status === "FAILED" ? "destructive" : "secondary"}>{run.receipt?.outcome ?? run.status.toLowerCase()}</Badge>
          {run.receipt?.state && <span className="text-sm text-muted-foreground">PR {run.receipt.state}</span>}
          <span className="ml-auto text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()} · {run.attemptCount} attempt(s)</span>
          {run.receipt?.url?.startsWith("https://") && <a href={run.receipt.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">Open PR<ArrowUpRight className="size-3" /></a>}
          {run.receipt?.prNumber && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("status", async () => { const r = await refreshDeploymentReceiptAction(entityId, run.id); if ("error" in r) throw new Error(r.error); await load(); })}>Refresh PR status</Button>}
          {run.status === "UNKNOWN" && run.method !== "http" && data.canRun && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("reconcile", () => execute(run))}>Reconcile delivery</Button>}
          {run.error && <p className="w-full text-sm text-destructive">{run.error}</p>}
          {run.receipt?.registrations && <ul className="w-full text-xs text-muted-foreground">{run.receipt.registrations.map((r) => <li key={r.path}>{r.subject}: registry v{r.version}, schema ID {r.id}</li>)}</ul>}
        </div>)}</div>
      </section>
  </div>;
}
