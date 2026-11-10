"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Loader2, Plus, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkflowSettingsSchema, type DeploymentMethod, type DeploymentWorkspace, type PreparedPlan, type RunView, type WorkflowSettings, type Credentials } from "@/lib/deployments/contracts";
import { getDeploymentWorkspaceAction, saveDeploymentConnectionAction, saveDeploymentWorkflowAction, verifyDeploymentConnectionAction, previewDeploymentAction, executeDeploymentAction, refreshDeploymentReceiptAction, importLegacyGitConnectionAction } from "../deployment-actions";
import { EntityDeploymentsTab } from "./EntityDeploymentsTab";

const METHODS = [{ value: "git", label: "Git PR" }, { value: "http", label: "API endpoint" }, { value: "registry", label: "Schema registry" }] as const;
const defaults = () => WorkflowSettingsSchema.parse({});
const selectClass = "min-w-0 w-full";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{children}</div>;
}
function Choice({ id, value, options, onChange, placeholder = "Select…" }: { id: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; placeholder?: string }) {
  return <Select value={value || null} onValueChange={(v) => { if (v !== null) onChange(v); }} items={options}>
    <SelectTrigger id={id} className={selectClass}><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent><SelectGroup>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}

type DeploymentWorkflowsTabProps = { entityId: string; entityName: string; initialFormat?: string; initialVersion?: string };

export function DeploymentWorkflowsTab(props: DeploymentWorkflowsTabProps) {
  return <DeploymentWorkflowEditor key={JSON.stringify([props.entityId, props.initialFormat, props.initialVersion])} {...props} />;
}

function DeploymentWorkflowEditor({ entityId, entityName, initialFormat = "", initialVersion = "" }: DeploymentWorkflowsTabProps) {
  const [data, setData] = useState<DeploymentWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [method, setMethod] = useState<DeploymentMethod>("git");
  const [format, setFormat] = useState(initialFormat);
  const [version, setVersion] = useState(initialVersion);
  const [workflowId, setWorkflowId] = useState("");
  const [name, setName] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [environment, setEnvironment] = useState("staging");
  const [settings, setSettings] = useState<WorkflowSettings>(defaults);
  const [referenceJson, setReferenceJson] = useState("{}");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ run: RunView; plan: PreparedPlan } | null>(null);
  const revision = useRef(0);

  const [connectionEditId, setConnectionEditId] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [url, setUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [authType, setAuthType] = useState<Credentials["authType"] | "keep">("bearer");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [supportsIdempotency, setSupportsIdempotency] = useState(false);
  const [connectionActive, setConnectionActive] = useState(true);

  const invalidate = () => { revision.current += 1; setPreview(null); };
  const changed = () => { invalidate(); setDirty(true); };
  const setting = <K extends keyof WorkflowSettings>(key: K, value: WorkflowSettings[K]) => { changed(); setSettings((s) => ({ ...s, [key]: value })); };
  const load = useCallback(() => getDeploymentWorkspaceAction(entityId).then((result) => {
    if ("error" in result) { setError(result.error); return; }
    setError(null); setData(result.data);
    setFormat((current) => current || result.data.formats[0]?.key || "");
    setVersion((current) => current || result.data.formats.find((f) => f.key === (initialFormat || result.data.formats[0]?.key))?.versions[0]?.toString() || "");
  }), [entityId, initialFormat]);
  useEffect(() => { void load().catch(() => setError("Could not load deployment workflows")); }, [load]);
  const pending = data?.runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");
  useEffect(() => { if (!pending) return; const timer = setInterval(() => { void load().catch(() => undefined); }, 3000); return () => clearInterval(timer); }, [pending, load]);

  async function action(label: string, run: () => Promise<void>) {
    setBusy(label); setError(null);
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : "Deployment request failed"); }
    finally { setBusy(null); }
  }
  const connectionOptions = data?.connections.filter((c) => c.method === method) ?? [];
  const workflowOptions = data?.workflows.filter((w) => data.connections.find((c) => c.id === w.connectionId)?.method === method) ?? [];
  const availableVersions = data?.formats.find((f) => f.key === format)?.versions ?? [];
  const selectedAvailable = availableVersions.includes(Number(version));

  function chooseWorkflow(id: string) {
    invalidate(); setDirty(false); setWorkflowId(id);
    const w = data?.workflows.find((w) => w.id === id);
    setName(w?.name ?? ""); setConnectionId(w?.connectionId ?? ""); setEnvironment(w?.environment ?? "staging");
    setSettings(w?.settings ?? defaults()); setReferenceJson(JSON.stringify(w?.settings.referenceSubjects ?? {}, null, 2));
    if (w && w.format !== format) { setFormat(w.format); setVersion(data?.formats.find((f) => f.key === w.format)?.versions[0]?.toString() ?? ""); }
  }
  function chooseMethod(value: string) {
    invalidate(); setMethod(value as DeploymentMethod); chooseWorkflow(""); setConnectionEditId(""); setConnectionName(""); setUrl("");
    setAuthType(value === "git" ? "bearer" : "none"); setToken(""); setPassword(""); setPrivateKey(""); setSigningSecret("");
  }
  function editConnection(id: string) {
    invalidate(); setConnectionEditId(id);
    const c = data?.connections.find((c) => c.id === id);
    setConnectionName(c?.name ?? ""); setUrl(c?.config.url ?? ""); setBaseBranch(c?.config.baseBranch ?? "main");
    setSupportsIdempotency(c?.config.supportsIdempotency ?? false); setConnectionActive(c?.active ?? true);
    setAuthType(c ? "keep" : method === "git" ? "bearer" : "none"); setToken(""); setPassword(""); setPrivateKey(""); setSigningSecret("");
  }
  async function saveConnection() {
    const credentials = authType === "keep" ? undefined : { authType, token: token || undefined, username: username || undefined, password: password || undefined, appId: appId || undefined, installationId: installationId || undefined, privateKey: privateKey || undefined, signingSecret: signingSecret || undefined };
    const result = await saveDeploymentConnectionAction(entityId, { id: connectionEditId || undefined, name: connectionName, method, config: { url, baseBranch, supportsIdempotency }, credentials, active: connectionActive });
    if ("error" in result) throw new Error(result.error);
    invalidate(); setConnectionEditId(result.data.id); setConnectionId(result.data.id); setDirty(true); setAuthType("keep");
    setToken(""); setPassword(""); setPrivateKey(""); setSigningSecret("");
    toast.success("Connection saved. Credentials stay on the server."); await load();
  }
  async function saveWorkflow() {
    let references: Record<string, string>;
    try { references = JSON.parse(referenceJson); } catch { throw new Error("Reference subjects must be a JSON object"); }
    const result = await saveDeploymentWorkflowAction(entityId, { id: workflowId || undefined, name, connectionId, format, environment, settings: { ...settings, referenceSubjects: references }, active: true });
    if ("error" in result) throw new Error(result.error);
    invalidate(); setWorkflowId(result.data.id); setDirty(false); await load(); toast.success("Workflow saved");
  }
  async function prepare() {
    const ticket = ++revision.current;
    const result = await previewDeploymentAction(entityId, { workflowId, version: Number(version), idempotencyKey: crypto.randomUUID() });
    if (ticket !== revision.current) return;
    if ("error" in result) throw new Error(result.error);
    setPreview(result.data); await load();
  }
  async function execute(run: RunView) {
    const result = await executeDeploymentAction(entityId, { runId: run.id, planHash: run.planHash });
    if ("error" in result) throw new Error(result.error);
    setPreview(null); await load(); toast.success(result.data.status === "QUEUED" ? "Delivery queued" : `Delivery ${result.data.status.toLowerCase()}`);
  }

  return <div className="flex min-w-0 flex-col gap-5" data-testid="deployment-workflows-tab">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-heading-2">Deployments</h2><p className="text-sm text-muted-foreground">Deliver a published schema version. Each method records its own result; a successful handoff does not confirm a live application deployment.</p></div>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void action("refresh", load)}><RefreshCw data-icon="inline-start" />Refresh</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? (error ? null : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading workflows…</p>) : <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field id="deployment-format" label="Schema format"><Choice id="deployment-format" value={format} options={data.formats.map((f) => ({ value: f.key, label: f.key }))} onChange={(v) => { changed(); setFormat(v); setVersion(data.formats.find((f) => f.key === v)?.versions[0]?.toString() ?? ""); setWorkflowId(""); }} /></Field>
        <Field id="deployment-version" label="Published artifact version"><Choice id="deployment-version" value={version} options={availableVersions.map((v) => ({ value: String(v), label: `v${v}` }))} onChange={(v) => { invalidate(); setVersion(v); }} /></Field>
      </div>
      {!selectedAvailable && <p className="text-sm text-muted-foreground">Publish this schema version in Schemas before delivering it. An unavailable selected version is never replaced silently.</p>}
      <Tabs value={method} onValueChange={(v) => chooseMethod(String(v))} className="min-w-0">
        <div className="min-w-0 overflow-x-auto p-1"><TabsList variant="line" aria-label="Deployment methods">{METHODS.map((m) => <TabsTrigger key={m.value} value={m.value} className="shrink-0 px-4">{m.label}</TabsTrigger>)}</TabsList></div>
        {METHODS.map((m) => <TabsContent key={m.value} value={m.value} className="min-w-0">
          <div className="flex flex-col gap-4 pt-2">
            <p className="text-sm text-muted-foreground">{method === "git" ? "Create a reviewable GitHub PR under schemas/tenant/domain/product/schema/version. No merge or deployment is performed automatically." : method === "http" ? "Send a JSON envelope with the exact version and schema files. The receiving API owns all subsequent processing." : "Register Avro, JSON Schema or Protobuf with a Confluent-compatible registry. No topic or application is provisioned."}</p>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field id="deployment-workflow" label="Saved workflow"><Choice id="deployment-workflow" value={workflowId} options={workflowOptions.map((w) => ({ value: w.id, label: w.name }))} onChange={chooseWorkflow} placeholder="Create a workflow or select an existing one" /></Field>
              <Button variant="outline" className="self-end" onClick={() => chooseWorkflow("")}><Plus data-icon="inline-start" />New workflow</Button>
            </div>
            <fieldset className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" disabled={!!busy || !data.canRun}>
              <legend className="px-1 text-sm font-medium">Workflow settings</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="workflow-name" label="Workflow name"><Input id="workflow-name" value={name} onChange={(e) => { changed(); setName(e.target.value); }} placeholder="Staging schema delivery" /></Field>
                <Field id="workflow-environment" label="Environment label"><Input id="workflow-environment" value={environment} onChange={(e) => { changed(); setEnvironment(e.target.value); }} /></Field>
                <Field id="workflow-connection" label="Connection"><Choice id="workflow-connection" value={connectionId} options={connectionOptions.filter((c) => c.active).map((c) => ({ value: c.id, label: c.name }))} onChange={(v) => { changed(); setConnectionId(v); }} /></Field>
                {method === "git" && <Field id="workflow-contract-version" label="Destination contract version"><Input id="workflow-contract-version" value={settings.contractVersion} onChange={(e) => setting("contractVersion", e.target.value)} placeholder="1.0.0_snapshot" /></Field>}
                {method === "registry" && <Field id="workflow-subject" label="Registry subject"><Input id="workflow-subject" value={settings.subject} onChange={(e) => setting("subject", e.target.value)} placeholder="account-activation-value" /></Field>}
              </div>
              {method === "git" && <>
                <Field id="workflow-title" label="PR title (optional)"><Input id="workflow-title" value={settings.title} onChange={(e) => setting("title", e.target.value)} /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.eventContract} onChange={(e) => setting("eventContract", e.target.checked)} />Prepare an Event Schema Central contract bundle</label>
                {settings.eventContract && <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">Uses the same hierarchy, plus repository-owned metadata, examples, generation and validation. An operator must install and approve its toolchain.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field id="workflow-kind" label="Contract kind"><Choice id="workflow-kind" value={settings.contractKind} options={[{ value: "Topic", label: "Event topic" }, { value: "Entity", label: "Reusable entity" }]} onChange={(v) => setting("contractKind", v as "Topic" | "Entity")} /></Field>
                    <Field id="workflow-change" label="Contract change"><Choice id="workflow-change" value={settings.change} options={[{ value: "create", label: "Create contract" }, { value: "new-version", label: "Add snapshot version" }, { value: "update-snapshot", label: "Update snapshot" }]} onChange={(v) => setting("change", v as WorkflowSettings["change"])} /></Field>
                  </div>
                  <Field id="workflow-metadata" label="Version metadata (YAML)"><Textarea id="workflow-metadata" value={settings.metadata} onChange={(e) => setting("metadata", e.target.value)} rows={4} /></Field>
                  <Field id="workflow-example" label="Valid example (CloudEvent for a topic, payload for an entity)"><Textarea id="workflow-example" value={settings.example} onChange={(e) => setting("example", e.target.value)} rows={7} /></Field>
                  <details><summary className="cursor-pointer text-sm">Shared topic settings (optional)</summary><Textarea aria-label="Topic configuration YAML" value={settings.topicConfig} onChange={(e) => setting("topicConfig", e.target.value)} rows={5} className="mt-2" /></details>
                </div>}
              </>}
              {method === "registry" && <details><summary className="cursor-pointer text-sm">Dependency subjects</summary><p className="my-2 text-sm text-muted-foreground">Map each dependent artifact file path to its registry subject. The registry assigns its own versions.</p><Textarea aria-label="Dependency subject mapping" value={referenceJson} onChange={(e) => { changed(); setReferenceJson(e.target.value); }} rows={4} /></details>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                {dirty && <span className="mr-auto text-sm text-muted-foreground">Save changes before previewing.</span>}
                <Button variant="outline" disabled={!name || !connectionId || !format} onClick={() => void action("save-workflow", saveWorkflow)}>Save workflow</Button>
                <Button disabled={dirty || !workflowId || !selectedAvailable} onClick={() => void action("preview", prepare)}>{busy === "preview" && <Loader2 className="animate-spin" data-icon="inline-start" />}Validate and preview</Button>
              </div>
            </fieldset>
            {data.canConfigure && <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer text-sm font-medium">Manage {m.label} connections</summary>
              <fieldset className="mt-4 flex min-w-0 flex-col gap-3" disabled={!!busy}>
                {method === "git" && data.legacyGit?.map((legacy) => <Button key={legacy.id} variant="outline" className="self-start" onClick={() => void action("import", async () => { const result = await importLegacyGitConnectionAction(entityId, legacy.id); if ("error" in result) throw new Error(result.error); setConnectionId(result.data.id); setDirty(true); await load(); toast.success("Legacy settings imported into this tenant"); })}>Import {legacy.name}</Button>)}
                <div className="flex flex-wrap items-end gap-2"><div className="min-w-48 flex-1"><Field id="connection-edit" label="Edit a connection"><Choice id="connection-edit" value={connectionEditId} options={connectionOptions.map((c) => ({ value: c.id, label: c.name + (c.active ? "" : " (disabled)") }))} onChange={editConnection} placeholder="New connection" /></Field></div><Button variant="outline" onClick={() => editConnection("")}>New connection</Button></div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="connection-name" label="Connection name"><Input id="connection-name" value={connectionName} onChange={(e) => setConnectionName(e.target.value)} /></Field>
                  <Field id="connection-url" label={method === "git" ? "GitHub repository URL" : "Endpoint URL"}><Input id="connection-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={method === "git" ? "https://github.com/organization/repository" : "https://example.com"} /></Field>
                  {method === "git" && <Field id="connection-branch" label="Base branch"><Input id="connection-branch" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} /></Field>}
                  <Field id="connection-auth" label="Authentication"><Choice id="connection-auth" value={authType} options={[...(connectionEditId ? [{ value: "keep", label: "Keep existing credentials" }] : []), ...(method === "git" ? [{ value: "bearer", label: "GitHub token" }, { value: "github-app", label: "GitHub App" }] : [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "basic", label: "Basic authentication" }])]} onChange={(v) => setAuthType(v as typeof authType)} /></Field>
                </div>
                {authType === "bearer" && <Field id="connection-token" label="Token"><Input id="connection-token" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>}
                {authType === "basic" && <div className="grid gap-3 sm:grid-cols-2"><Field id="connection-username" label="Username"><Input id="connection-username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field><Field id="connection-password" label="Password / API secret"><Input id="connection-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field></div>}
                {authType === "github-app" && <><div className="grid gap-3 sm:grid-cols-2"><Field id="connection-app" label="App ID"><Input id="connection-app" value={appId} onChange={(e) => setAppId(e.target.value)} /></Field><Field id="connection-installation" label="Installation ID"><Input id="connection-installation" value={installationId} onChange={(e) => setInstallationId(e.target.value)} /></Field></div><Field id="connection-private-key" label="App private key (PEM)"><Textarea id="connection-private-key" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4} /></Field></>}
                {method === "http" && <><Field id="connection-signing" label="HMAC signing secret (optional; replaced with credential changes)"><Input id="connection-signing" type="password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={supportsIdempotency} onChange={(e) => setSupportsIdempotency(e.target.checked)} />The endpoint deduplicates Idempotency-Key requests (allows safe automatic retries).</label></>}
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={connectionActive} onChange={(e) => setConnectionActive(e.target.checked)} />Connection enabled</label>
                <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={!connectionEditId} onClick={() => void action("verify", async () => { const r = await verifyDeploymentConnectionAction(entityId, connectionEditId); if ("error" in r) throw new Error(r.error); toast.success(r.data); })}>Verify connection</Button><Button disabled={!connectionName || !url} onClick={() => void action("save-connection", saveConnection)}>Save connection</Button></div>
              </fieldset>
            </details>}
          </div>
        </TabsContent>)}
      </Tabs>
      {preview && <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4" aria-label="Validated delivery preview" data-testid="deployment-preview">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Review {preview.plan.bundle.format} v{preview.plan.bundle.version}</h3><Badge variant="info">{preview.run.environment}</Badge></div>
        <p className="break-all text-xs text-muted-foreground">{preview.plan.bundle.contentHash}</p>
        <p className="break-all text-sm">Destination: {preview.plan.connectionConfig.url}{preview.run.method === "git" ? ` · ${preview.plan.connectionConfig.baseBranch} · ${preview.plan.settings.contractVersion}` : ""}</p>
        <ul className="list-inside list-disc text-sm text-muted-foreground">{preview.plan.validation.map((v) => <li key={v}>{v}</li>)}</ul>
        <div className="max-h-96 overflow-auto rounded-md bg-muted/30 p-3"><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(preview.plan.files ?? { destination: preview.plan.connectionConfig.url, artifact: preview.plan.bundle }, null, 2)}</pre></div>
        <Button className="self-end" disabled={!!busy || !data.canRun} data-testid="deployment-execute" onClick={() => void action("execute", () => execute(preview.run))}><Send data-icon="inline-start" />{method === "git" ? "Create Git PR" : method === "registry" ? "Register schema" : "Send to API"}</Button>
      </section>}
      <section className="flex min-w-0 flex-col gap-3" aria-label="Delivery history"><h3 className="text-sm font-semibold">Delivery history</h3>
        {!data.runs.length && <p className="text-sm text-muted-foreground">No delivery runs yet. Save a workflow, validate it, then execute the preview.</p>}
        <div className="flex flex-col gap-2">{data.runs.map((run) => <div key={run.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3" data-testid="deployment-run">
          <span className="text-sm font-medium">{METHODS.find((m) => m.value === run.method)?.label} · {run.format} v{run.artifactVersion}</span><span className="text-sm text-muted-foreground">{run.environment}</span>
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
    </>}
    <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Recorded environments and generated-output comparison</summary>
      {!!data?.legacyMarkers?.length && <p className="mt-3 text-sm text-muted-foreground">Legacy deployment markers (environment unknown): {data.legacyMarkers.map((m) => `${m.format} v${m.version}`).join(", ")}. These markers do not establish a live deployment.</p>}
      <div className="mt-4"><EntityDeploymentsTab entityId={entityId} entityName={entityName} recordVersion={{ targetId: selectedAvailable ? `${entityId}:${format}` : "", version: Number(version) }} /></div>
    </details>
  </div>;
}
