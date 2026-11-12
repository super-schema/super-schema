"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FieldGroup } from "@/components/ui/field";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { WorkflowSettingsSchema, workflowTargets, type DeploymentMethod, type ProductDeploymentConfiguration, type WorkflowSettings, type WorkflowView } from "@/lib/deployments/contracts";
import { getProductDeploymentConfigurationAction, saveProductDeploymentWorkflowAction } from "@/app/(dashboard)/deployments/settings-actions";
import { DeploymentField as Field, DeploymentChoice as Choice, DEPLOYMENT_METHODS, targetOptions, targetLabel, WorkflowVariablesFields } from "./DeploymentFields";

export function ProductDeploymentWorkflows({ productId }: { productId: string }) {
  const [data, setData] = useState<ProductDeploymentConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<DeploymentMethod>("git");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(0);
  const load = useCallback(async () => {
    const result = await getProductDeploymentConfigurationAction(productId);
    if ("error" in result) throw new Error(result.error);
    setData(result.data); setError(null);
  }, [productId]);
  useEffect(() => {
    // The server response updates state asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  function open(workflow?: WorkflowView) {
    setEditing(workflow?.id ?? "new"); setDraft((value) => value + 1);
    setMethod(data?.connections.find((c) => c.id === workflow?.connectionId)?.method ?? "git");
  }
  const definition = data && editing ? <DefinitionEditor key={`${editing}:${method}:${draft}`} productId={productId} method={method} data={data} workflow={data.workflows.find((w) => w.id === editing)} saved={async (id) => { await load(); setEditing(id); }} /> : null;
  return <div className="flex min-w-0 flex-col gap-4" data-testid="product-deployment-workflows">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Deployment workflows</h2><p className="text-sm text-muted-foreground">Reusable delivery settings for this product. Select a workflow to view or edit its configuration.</p></div>
      <div className="flex flex-wrap items-center gap-3"><Link href="/admin/workflows/connections" className="text-sm text-primary underline">Tenant connections and environments</Link><Button disabled={!data?.canManage} onClick={() => open()}>New workflow</Button></div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? <Button variant="outline" className="self-start" onClick={() => void load().catch((e: Error) => setError(e.message))}>Reload workflows</Button> : <div className={cn("grid min-w-0 gap-5", editing && "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]")}>
      <section aria-label="Existing workflows" className="min-w-0 self-start rounded-lg border border-border">
        <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Method / destination</TableHead><TableHead>Supported targets</TableHead><TableHead>Environment</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{data.workflows.length ? data.workflows.map((workflow) => {
            const connection = data.connections.find((c) => c.id === workflow.connectionId);
            return <TableRow key={workflow.id} data-testid="product-workflow-row" data-state={editing === workflow.id ? "selected" : undefined}>
              <TableCell className="align-top"><span className="font-medium">{workflow.name}</span>{workflow.scope === "schema" && <p className="text-xs text-muted-foreground">Schema workflow</p>}</TableCell>
              <TableCell className="align-top"><p>{DEPLOYMENT_METHODS.find((m) => m.value === connection?.method)?.label ?? "Unavailable"}</p><p className="text-xs text-muted-foreground">{connection?.name ?? "Connection unavailable"}</p></TableCell>
              <TableCell className="max-w-64 align-top"><div className="flex flex-wrap gap-1">{workflowTargets(workflow).map((target) => <Badge key={target} variant="outline">{targetLabel(target)}</Badge>)}</div></TableCell>
              <TableCell className="align-top">{workflow.environment}</TableCell><TableCell className="align-top"><Badge variant={workflow.active ? "success" : "secondary"}>{workflow.active ? "Enabled" : "Disabled"}</Badge></TableCell>
              <TableCell className="align-top"><Button size="sm" variant="outline" aria-label={`${data.canManage ? "Edit" : "View"} ${workflow.name}`} onClick={() => open(workflow)}>{data.canManage ? "Edit" : "View"}</Button></TableCell>
            </TableRow>;
          }) : <TableRow><TableCell colSpan={6} className="text-muted-foreground">No workflows defined. Create a workflow to share it across schemas in this product.</TableCell></TableRow>}</TableBody>
        </Table>
      </section>
      {editing && <section className="flex min-w-0 flex-col gap-4" aria-label="Workflow editor">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{editing === "new" ? "New workflow" : data.workflows.find((w) => w.id === editing)?.name}</h3><Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Close editor</Button></div>
        {editing === "new" ? <Tabs value={method} onValueChange={(v) => setMethod(v as DeploymentMethod)}><div className="min-w-0 overflow-x-auto"><TabsList variant="line" aria-label="Workflow types">{DEPLOYMENT_METHODS.map((m) => <TabsTrigger key={m.value} value={m.value}>{m.label}</TabsTrigger>)}</TabsList></div><TabsContent value={method}>{definition}</TabsContent></Tabs> : <><p className="text-sm text-muted-foreground">{DEPLOYMENT_METHODS.find((m) => m.value === method)?.label}</p>{definition}</>}
      </section>}
    </div>}
  </div>;
}

function DefinitionEditor({ productId, method, data, workflow, saved }: { productId: string; method: DeploymentMethod; data: ProductDeploymentConfiguration; workflow?: WorkflowView; saved: (id: string) => Promise<void> }) {
  const [name, setName] = useState(workflow?.name ?? "");
  const [connectionId, setConnectionId] = useState(workflow?.connectionId ?? "");
  const [supportedTargets, setSupportedTargets] = useState<string[]>(() => workflow ? [...workflowTargets(workflow)] : []);
  const [environment, setEnvironment] = useState(workflow?.environment ?? data.environments[0] ?? "");
  const [settings, setSettings] = useState<WorkflowSettings>(() => workflow?.settings ?? WorkflowSettingsSchema.parse({}));
  const [referenceJson, setReferenceJson] = useState(JSON.stringify(workflow?.settings.referenceSubjects ?? {}, null, 2));
  const [active, setActive] = useState(workflow?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = targetOptions(method, data.targetMethods);
  async function save() {
    setBusy(true); setError(null);
    try {
      const result = await saveProductDeploymentWorkflowAction(productId, { id: workflow?.id, name, connectionId, supportedTargets, environment, active, settings: { ...settings, referenceSubjects: JSON.parse(referenceJson) } });
      if ("error" in result) throw new Error(result.error);
      await saved(result.data.id); toast.success("Product workflow saved");
    } catch(e) { setError(e instanceof Error ? e.message : "Could not save workflow"); } finally { setBusy(false); }
  }
  return <fieldset disabled={busy || !data.canManage} className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4">
    <legend className="px-1 text-sm font-medium">Workflow definition</legend>
    {workflow?.scope === "schema" && <p className="text-sm text-muted-foreground">This legacy definition belongs to its original schema. New workflows are shared across the product.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <FieldGroup className="grid sm:grid-cols-2">
      <Field id="workflow-name" label="Workflow name"><Input id="workflow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Staging schema delivery" /></Field>
      <Field id="workflow-environment" label="Default environment"><Choice id="workflow-environment" value={environment} options={data.environments.map((value) => ({ value, label: value }))} onChange={setEnvironment} /></Field>
      <Field id="workflow-connection" label={method === "registry" ? "Default schema registry" : method === "git" ? "Git repository" : "Default API endpoint"}><Choice id="workflow-connection" value={connectionId} options={data.connections.filter((c) => c.active && c.method === method).map((c) => ({ value: c.id, label: c.name }))} onChange={setConnectionId} /></Field>
    </FieldGroup>
    <fieldset className="min-w-0 rounded-md border border-border p-3"><legend className="px-1 text-sm font-medium">Supported targets</legend><FieldGroup className="grid gap-3 sm:grid-cols-2">{targets.map((target) => <label key={target.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={supportedTargets.includes(target.value)} onChange={(e) => setSupportedTargets((current) => e.target.checked ? [...current, target.value] : current.filter((key) => key !== target.value))} />{target.label}</label>)}</FieldGroup>{!supportedTargets.length && <p className="mt-2 text-xs text-muted-foreground">Select at least one target. Each deployment chooses one target and published version.</p>}</fieldset>
    {method === "git" && <FieldGroup>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.eventContract} onChange={(e) => setSettings((s) => ({ ...s, eventContract: e.target.checked }))} />Prepare an Event Schema Central contract bundle</label>
      {settings.eventContract && <FieldGroup className="grid sm:grid-cols-2">
        <Field id="workflow-kind" label="Contract kind"><Choice id="workflow-kind" value={settings.contractKind} options={[{ value: "Topic", label: "Event topic" }, { value: "Entity", label: "Reusable entity" }]} onChange={(v) => setSettings((s) => ({ ...s, contractKind: v as "Topic" | "Entity" }))} /></Field>
        <Field id="workflow-change" label="Contract change"><Choice id="workflow-change" value={settings.change} options={[{ value: "create", label: "Create contract" }, { value: "new-version", label: "Add snapshot version" }, { value: "update-snapshot", label: "Update snapshot" }]} onChange={(v) => setSettings((s) => ({ ...s, change: v as WorkflowSettings["change"] }))} /></Field>
      </FieldGroup>}
    </FieldGroup>}
    <p className="text-sm text-muted-foreground">Optional default variables can be overridden for each deployment.</p>
    <WorkflowVariablesFields method={method} settings={settings} onChange={setSettings} referenceJson={referenceJson} onReferenceChange={setReferenceJson} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Workflow enabled</label>
    <Button className="self-end" disabled={!name.trim() || !connectionId || !supportedTargets.length || !environment} onClick={() => void save()}>Save workflow</Button>
  </fieldset>;
}
