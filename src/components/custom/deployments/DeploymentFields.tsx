"use client";

import type { ReactNode } from "react";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getSchemaTargetCatalog, getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { deploymentMethodsFor, type TargetMethodMappings } from "@/lib/deployments/target-methods";
import type { DeploymentMethod, WorkflowSettings } from "@/lib/deployments/contracts";

export const DEPLOYMENT_METHODS = [{ value: "git", label: "Git PR" }, { value: "http", label: "API endpoint" }, { value: "registry", label: "Schema registry" }] as const;
export const targetLabel = (key: string) => getSchemaTargetDefinition(key)?.displayName ?? key;
export function targetOptions(method?: DeploymentMethod, mappings?: TargetMethodMappings) {
  return getSchemaTargetCatalog().filter((t) => t.enabledInSchemaTab && (!method || deploymentMethodsFor(t.key, mappings).includes(method))).map((t) => ({ value: t.key, label: t.displayName }));
}
export function DeploymentField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <Field><FieldLabel htmlFor={id}>{label}</FieldLabel>{children}</Field>;
}
export function DeploymentChoice({ id, value, options, onChange, placeholder = "Select…" }: { id: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; placeholder?: string }) {
  return <Select value={value || null} onValueChange={(v) => { if (v !== null) onChange(v); }} items={options}>
    <SelectTrigger id={id} className="min-w-0 w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
    <SelectContent><SelectGroup>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}
export function deploymentVariables(s: WorkflowSettings) {
  const { contractVersion, title, metadata, example, topicConfig, subject, referenceSubjects, expectedPayloadHash } = s;
  return { contractVersion, title, metadata, example, topicConfig, subject, referenceSubjects, expectedPayloadHash };
}
export function WorkflowVariablesFields({ method, settings, onChange, referenceJson, onReferenceChange, generatedTitle, onResetTitle }: {
  generatedTitle?: string; onResetTitle?: () => void;
  method: DeploymentMethod; settings: WorkflowSettings; onChange: (s: WorkflowSettings) => void; referenceJson: string; onReferenceChange: (s: string) => void;
}) {
  const set = <K extends keyof WorkflowSettings>(key: K, value: WorkflowSettings[K]) => onChange({ ...settings, [key]: value });
  return <FieldGroup>
    {method === "http" && <p className="text-sm text-muted-foreground">The API receives the selected target, version, environment and artifact files. No additional variables are required.</p>}
    {method === "git" && <>
      <FieldGroup className="grid sm:grid-cols-2">
        <DeploymentField id="workflow-contract-version" label="Destination contract version"><Input id="workflow-contract-version" value={settings.contractVersion} onChange={(e) => set("contractVersion", e.target.value)} /></DeploymentField>
        <DeploymentField id="workflow-title" label={generatedTitle ? "PR title" : "PR title (optional)"}><Input id="workflow-title" maxLength={250} value={settings.title} onChange={(e) => set("title", e.target.value)} />{generatedTitle && onResetTitle && <Button variant="ghost" size="sm" className="self-start" onClick={onResetTitle}>Reset to generated</Button>}</DeploymentField>
      </FieldGroup>
      {settings.eventContract && <>
        <DeploymentField id="workflow-metadata" label="Version metadata (YAML)"><Textarea id="workflow-metadata" value={settings.metadata} onChange={(e) => set("metadata", e.target.value)} rows={4} /></DeploymentField>
        <DeploymentField id="workflow-example" label="Valid example (CloudEvent for a topic, payload for an entity)"><Textarea id="workflow-example" value={settings.example} onChange={(e) => set("example", e.target.value)} rows={5} /></DeploymentField>
        <DeploymentField id="workflow-topic" label="Topic configuration (YAML, optional)"><Textarea id="workflow-topic" value={settings.topicConfig} onChange={(e) => set("topicConfig", e.target.value)} rows={3} /></DeploymentField>
      </>}
    </>}
    {method === "registry" && <>
      <DeploymentField id="workflow-subject" label="Registry subject"><Input id="workflow-subject" value={settings.subject} onChange={(e) => set("subject", e.target.value)} placeholder="account-activation-value" /></DeploymentField>
      <DeploymentField id="workflow-references" label="Dependency subjects (JSON, optional)"><Textarea id="workflow-references" value={referenceJson} onChange={(e) => onReferenceChange(e.target.value)} rows={3} /><p className="text-xs text-muted-foreground">Map dependent artifact paths to their registry subjects. Registry versions are assigned independently.</p></DeploymentField>
    </>}
  </FieldGroup>;
}
