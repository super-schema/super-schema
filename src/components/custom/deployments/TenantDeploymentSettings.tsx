"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EnvironmentPipelineEditor, EnvironmentWorkflowChanges, defaultReassignment, environmentProblems, environmentRenames, removedEnvironments, toDefinitions, toRows, type EnvironmentRow } from "./EnvironmentPipelineEditor";

/** Unsaved environment edits survive leaving the page (per browser), and are dropped once the saved list changes underneath them. */
const DRAFT_KEY = "superschema.deploymentEnvironments.draft";
type Draft = { base: string; rows: EnvironmentRow[]; reassign: Record<string, string | null> };
const baseOf = (data: DeploymentConfiguration) => JSON.stringify([data.environments, data.environmentDetails ?? {}]);
function readDraft(base: string): Draft | null {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null; return d && d.base === base && Array.isArray(d.rows) ? d : null; } catch { return null; }
}
function writeDraft(draft: Draft | null) {
  try { if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable: edits stay in memory only */ }
}
import { FieldGroup } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DeploymentField as Field, DeploymentChoice as Choice, DEPLOYMENT_METHODS } from "./DeploymentFields";
import type { Credentials, DeploymentConfiguration, DeploymentMethod } from "@/lib/deployments/contracts";
import { deploymentMethodsFor, registryTarget, type TargetMethodMappings } from "@/lib/deployments/target-methods";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { getTenantDeploymentConfigurationAction, saveDeploymentTargetMethodsAction, saveDeploymentEnvironmentsAction, saveTenantDeploymentConnectionAction, verifyTenantDeploymentConnectionAction, importTenantLegacyGitConnectionAction } from "@/app/(dashboard)/deployments/settings-actions";

export type DeploymentSettingsView = "all" | "environments" | "connections" | "targets";
export function TenantDeploymentSettings({ view = "all" }: { view?: DeploymentSettingsView } = {}) {
  const show = (v: DeploymentSettingsView) => view === "all" || view === v;
  const [data, setData] = useState<DeploymentConfiguration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [environments, setEnvironmentRows] = useState<EnvironmentRow[]>([]);
  const [reassign, setReassignState] = useState<Record<string, string | null>>({});
  const [restored, setRestored] = useState(false);
  const base = data ? baseOf(data) : "";
  const savedRows = data ? JSON.stringify(toDefinitions(toRows(data.environments, data.environmentDetails))) : "";
  const dirty = !!data && (JSON.stringify(toDefinitions(environments)) !== savedRows || Object.keys(environmentRenames(environments)).length > 0);
  function setEnvironments(rows: EnvironmentRow[]) { setEnvironmentRows(rows); if (data) writeDraft({ base, rows, reassign }); }
  function setReassign(name: string, to: string | null) { const next = { ...reassign, [name]: to }; setReassignState(next); if (data) writeDraft({ base, rows: environments, reassign: next }); }
  function discardDraft() { if (!data) return; writeDraft(null); setRestored(false); setReassignState({}); setEnvironmentRows(toRows(data.environments, data.environmentDetails)); }
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState<DeploymentMethod>("git");
  const load = useCallback(async () => {
    const r = await getTenantDeploymentConfigurationAction();
    if ("error" in r) throw new Error(r.error);
    setData(r.data); setError(null);
    const draft = readDraft(baseOf(r.data));
    if (draft) { setEnvironmentRows(draft.rows); setReassignState(draft.reassign ?? {}); setRestored(true); }
    else { writeDraft(null); setEnvironmentRows(toRows(r.data.environments, r.data.environmentDetails)); setReassignState({}); setRestored(false); }
  }, []);
  useEffect(() => {
    // Loading updates state only after the server action resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  return <div className="flex min-w-0 max-w-4xl flex-col gap-6" data-testid="tenant-deployment-settings">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!data ? <Button variant="outline" className="self-start" onClick={() => void load().catch((e: Error) => setError(e.message))}>Reload settings</Button> : <>
      {show("environments") && <section className="flex flex-col gap-4 rounded-lg border border-border p-4" aria-labelledby="environment-heading">
        <div><h2 id="environment-heading" className="text-base font-semibold">Environments</h2><p className="text-sm text-muted-foreground">The promotion order for every product and schema in this tenant, from the first stage to production. Drag or use the arrows to reorder. Git PRs for an environment target its branch: the environment name unless you set one.</p></div>
        {restored && dirty && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"><span>Your unsaved environment changes were restored.</span><Button type="button" variant="ghost" size="sm" onClick={discardDraft}>Discard changes</Button></div>}
        <EnvironmentPipelineEditor rows={environments} onChange={setEnvironments} />
        {environmentProblems(environments).map((p) => <p key={p} className="text-sm text-destructive">{p}</p>)}
        <EnvironmentWorkflowChanges saved={data.environments} rows={environments} usage={data.environmentUsage ?? {}} reassign={reassign} onReassign={setReassign} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={discardDraft}>Discard changes</Button>}
          <Button disabled={busy || !dirty || environmentProblems(environments).length > 0} onClick={() => {
            const usage = data.environmentUsage ?? {};
            const choices = Object.fromEntries(removedEnvironments(data.environments, environments).filter((name) => usage[name]?.length).map((name) => [name, name in reassign ? reassign[name] : defaultReassignment(name, data.environments, environments)]));
            setBusy(true); setError(null);
            void saveDeploymentEnvironmentsAction({ environments: toDefinitions(environments), renames: environmentRenames(environments), reassign: choices }).then(async (r) => {
              if ("error" in r) throw new Error(r.error);
              writeDraft(null); await load();
              const moved = (r.data as { moved?: { workflow: string; to: string | null }[] }).moved ?? [];
              toast.success(moved.length ? `Environments saved · ${moved.length} ${moved.length === 1 ? "workflow" : "workflows"} updated` : "Environments saved");
            }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
          }}>Save environments</Button>
        </div>
      </section>}
      {show("targets") && <TargetMethodSettings key={JSON.stringify(data.targetMethods)} mappings={data.targetMethods} reload={load} />}
      {show("connections") && <section className="flex min-w-0 flex-col gap-3" aria-labelledby="connections-heading">
        <div><h2 id="connections-heading" className="text-base font-semibold">Tenant connections</h2><p className="text-sm text-muted-foreground">Configure repositories, API destinations and schema registries once. Credentials stay encrypted on the server.</p></div>
        <Tabs value={method} onValueChange={(v) => setMethod(v as DeploymentMethod)}>
          <div className="overflow-x-auto"><TabsList variant="line" aria-label="Connection types">{DEPLOYMENT_METHODS.map((m) => <TabsTrigger key={m.value} value={m.value}>{m.label}</TabsTrigger>)}</TabsList></div>
          {DEPLOYMENT_METHODS.map((m) => <TabsContent key={m.value} value={m.value}>{method === m.value && <ConnectionEditor key={m.value} method={m.value} data={data} reload={load} />}</TabsContent>)}
        </Tabs>
      </section>}
    </>}
  </div>;
}

function ConnectionEditor({ method, data, reload }: { method: DeploymentMethod; data: DeploymentConfiguration; reload: () => Promise<void> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [gitRoot, setGitRoot] = useState("");
  const [authType, setAuthType] = useState<Credentials["authType"] | "keep">(method === "git" ? "bearer" : "none");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [supportsIdempotency, setSupportsIdempotency] = useState(false);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function clearSecrets() { setToken(""); setUsername(""); setPassword(""); setPrivateKey(""); setAppId(""); setInstallationId(""); setSigningSecret(""); }
  function choose(value: string) {
    const c = data.connections.find((c) => c.id === value);
    setId(c?.id ?? ""); setName(c?.name ?? ""); setUrl(c?.config.url ?? ""); setGitRoot(c?.config.gitRoot ?? "");
    setAuthType(c ? "keep" : method === "git" ? "bearer" : "none"); setActive(c?.active ?? true); setSupportsIdempotency(c?.config.supportsIdempotency ?? false); clearSecrets(); setDirty(false); setError(null);
  }
  async function run(work: () => Promise<void>) { setBusy(true); setError(null); try { await work(); } catch(e) { setError(e instanceof Error ? e.message : "Connection request failed"); } finally { setBusy(false); } }
  async function save() {
    const credentials = authType === "keep" ? undefined : { authType, token: token || undefined, username: username || undefined, password: password || undefined, appId: appId || undefined, installationId: installationId || undefined, privateKey: privateKey || undefined, signingSecret: signingSecret || undefined };
    const r = await saveTenantDeploymentConnectionAction({ id: id || undefined, name, method, config: { url, supportsIdempotency, ...(method === "git" ? { gitRoot: gitRoot.trim().replace(/^\/+|\/+$/g, "") || undefined } : {}) }, credentials, active });
    if ("error" in r) throw new Error(r.error);
    setId(r.data.id); clearSecrets(); setAuthType("keep"); setDirty(false); await reload(); toast.success("Tenant connection saved");
  }
  return <fieldset disabled={busy} className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" onChange={() => setDirty(true)}>
    <legend className="px-1 text-sm font-medium">{method === "registry" ? "Schema registry connection" : method === "git" ? "Git repository connection" : "API connection"}</legend>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {method === "git" && data.legacyGit?.map((c) => <Button key={c.id} variant="outline" className="self-start" onClick={() => void run(async () => { const r = await importTenantLegacyGitConnectionAction(c.id); if ("error" in r) throw new Error(r.error); await reload(); choose(r.data.id); toast.success("Legacy Git configuration imported into this tenant"); })}>Import {c.name}</Button>)}
    <FieldGroup className="grid sm:grid-cols-[1fr_auto]"><Field id="connection-edit" label="Saved connection"><Choice id="connection-edit" value={id} options={data.connections.filter((c) => c.method === method).map((c) => ({ value: c.id, label: c.name + (c.active ? "" : " (disabled)") }))} onChange={choose} placeholder="New connection" /></Field><Button variant="outline" className="self-end" onClick={() => choose("")}>New connection</Button></FieldGroup>
    <FieldGroup className="grid sm:grid-cols-2">
      <Field id="connection-name" label="Connection name"><Input id="connection-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="connection-url" label={method === "git" ? "GitHub repository URL" : method === "registry" ? "Schema registry URL" : "Endpoint URL"}><Input id="connection-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={method === "git" ? "https://github.com/organization/repository" : "https://example.com"} /></Field>
      {method === "git" && <Field id="connection-root" label="Repository root path"><Input id="connection-root" value={gitRoot} placeholder="Repository root" onChange={(e) => setGitRoot(e.target.value)} /></Field>}
      <Field id="connection-auth" label="Authentication"><Choice id="connection-auth" value={authType} options={[...(id ? [{ value: "keep", label: "Keep existing credentials" }] : []), ...(method === "git" ? [{ value: "bearer", label: "GitHub token" }, { value: "github-app", label: "GitHub App" }] : [{ value: "none", label: "None" }, { value: "bearer", label: "Bearer token" }, { value: "basic", label: "Basic authentication" }])]} onChange={(v) => { setAuthType(v as typeof authType); setDirty(true); }} /></Field>
    </FieldGroup>
    {method === "git" && <p className="text-xs text-muted-foreground">PRs target each environment&apos;s branch (set under Environments) and can be changed when a PR is created. Files are written to <span className="font-mono">{gitRoot.trim() ? `${gitRoot.trim().replace(/^\/+|\/+$/g, "")}/` : ""}&lt;domain&gt;/&lt;product&gt;/&lt;schema&gt;/&lt;version&gt;/</span>.</p>}
    <FieldGroup>
      {authType === "bearer" && <Field id="connection-token" label="Token"><Input id="connection-token" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} /></Field>}
      {authType === "basic" && <FieldGroup className="grid sm:grid-cols-2"><Field id="connection-username" label="Username"><Input id="connection-username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field><Field id="connection-password" label="Password / API secret"><Input id="connection-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field></FieldGroup>}
      {authType === "github-app" && <><FieldGroup className="grid sm:grid-cols-2"><Field id="connection-app" label="App ID"><Input id="connection-app" value={appId} onChange={(e) => setAppId(e.target.value)} /></Field><Field id="connection-installation" label="Installation ID"><Input id="connection-installation" value={installationId} onChange={(e) => setInstallationId(e.target.value)} /></Field></FieldGroup><Field id="connection-private-key" label="App private key (PEM)"><Textarea id="connection-private-key" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4} /></Field></>}
      {method === "http" && <><Field id="connection-signing" label="HMAC signing secret (optional; replaced with credential changes)"><Input id="connection-signing" type="password" autoComplete="new-password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} /></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={supportsIdempotency} onChange={(e) => setSupportsIdempotency(e.target.checked)} />The endpoint deduplicates Idempotency-Key requests.</label></>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Connection enabled</label>
    </FieldGroup>
    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={!id || dirty} onClick={() => void run(async () => { const r = await verifyTenantDeploymentConnectionAction(id); if ("error" in r) throw new Error(r.error); toast.success(r.data); })}>Verify saved connection</Button><Button disabled={!name.trim() || !url.trim()} onClick={() => void run(save)}>Save connection</Button></div>
  </fieldset>;
}


function TargetMethodSettings({ mappings, reload }: { mappings: TargetMethodMappings; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState(mappings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = [{ key: "*", displayName: "Default for other targets" }, ...getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab)];
  return <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4" aria-labelledby="target-method-heading">
    <div><h2 id="target-method-heading" className="text-base font-semibold">Target deployment methods</h2><p className="text-sm text-muted-foreground">The selected datastore or format determines the methods available on schema deployments. Avro, JSON Schema and Protobuf default to Git and schema registry; other targets default to Git and API.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3"><legend className="sr-only">Allowed methods by target</legend>{rows.map((target) => <div key={target.key} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-0"><span className="text-sm font-medium">{target.displayName}</span><div className="flex flex-wrap gap-4">{DEPLOYMENT_METHODS.map((method) => <label key={method.value} className="flex items-center gap-1.5 text-sm"><input type="checkbox" aria-label={`${target.displayName}: ${method.label}`} checked={deploymentMethodsFor(target.key, draft).includes(method.value)} disabled={method.value === "registry" && !registryTarget(target.key)} onChange={(e) => setDraft((current) => ({ ...current, [target.key]: e.target.checked ? [...deploymentMethodsFor(target.key, current), method.value] : deploymentMethodsFor(target.key, current).filter((m) => m !== method.value) }))} />{method.label}</label>)}</div></div>)}</fieldset>
    <Button className="self-end" disabled={busy} onClick={() => { setBusy(true); setError(null); void saveDeploymentTargetMethodsAction(draft).then(async (r) => { if ("error" in r) throw new Error(r.error); await reload(); toast.success("Target deployment methods saved"); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>Save target methods</Button>
  </section>;
}
