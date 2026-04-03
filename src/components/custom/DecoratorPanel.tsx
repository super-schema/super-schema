"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const DECORATOR_TABS = [
  "Structure", "Semantics", "Classification", "Policy",
  "Quality", "Lineage", "Operational", "Evolution",
] as const;

type TabId = typeof DECORATOR_TABS[number];

interface DecoratorPanelProps {
  fieldId: string;
  fieldName: string;
  decorators: Record<string, unknown>;
  onSave: (decorators: Record<string, unknown>) => void;
}

export function DecoratorPanel({ fieldName, decorators, onSave }: DecoratorPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("Structure");

  return (
    <div>
      <h3 className="text-heading-3 text-foreground mb-space-3">
        <span className="font-mono">{fieldName}</span> — Decorators
      </h3>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-space-1 mb-space-4">
        {DECORATOR_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-space-3 py-1 rounded-lg text-caption transition-colors ${
              activeTab === tab
                ? "bg-primary/20 text-primary font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="space-y-space-4">
        {activeTab === "Structure" && (
          <StructureTab decorators={decorators} onSave={onSave} />
        )}
        {activeTab === "Semantics" && (
          <SemanticsTab decorators={decorators} onSave={onSave} />
        )}
        {activeTab === "Classification" && (
          <ClassificationTab decorators={decorators} onSave={onSave} />
        )}
        {activeTab === "Policy" && (
          <PolicyTab decorators={decorators} onSave={onSave} />
        )}
        {activeTab === "Quality" && <PlaceholderTab name="Quality" />}
        {activeTab === "Lineage" && <PlaceholderTab name="Lineage" />}
        {activeTab === "Operational" && <PlaceholderTab name="Operational Hints" />}
        {activeTab === "Evolution" && (
          <EvolutionTab decorators={decorators} onSave={onSave} />
        )}
      </div>
    </div>
  );
}

function StructureTab({ decorators, onSave }: { decorators: Record<string, unknown>; onSave: (d: Record<string, unknown>) => void }) {
  const structure = (decorators.structure || {}) as Record<string, unknown>;
  return (
    <div className="space-y-space-3">
      <label className="flex items-center gap-space-2 text-body-small">
        <input type="checkbox" checked={!!structure.nullable} onChange={(e) => onSave({ ...decorators, structure: { ...structure, nullable: e.target.checked } })} className="accent-primary" />
        Nullable
      </label>
      <label className="flex items-center gap-space-2 text-body-small">
        <input type="checkbox" checked={!!structure.key} onChange={(e) => onSave({ ...decorators, structure: { ...structure, key: e.target.checked } })} className="accent-primary" />
        Primary Key
      </label>
    </div>
  );
}

function SemanticsTab({ decorators, onSave }: { decorators: Record<string, unknown>; onSave: (d: Record<string, unknown>) => void }) {
  const semantics = (decorators.semantics || {}) as Record<string, unknown>;
  return (
    <div className="space-y-space-3">
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Description</label>
        <textarea
          value={(semantics.description as string) || ""}
          onChange={(e) => onSave({ ...decorators, semantics: { ...semantics, description: e.target.value } })}
          className="w-full h-20 bg-muted rounded-lg px-space-3 py-space-2 text-body-small text-foreground outline-none resize-none border border-border focus:border-ring"
          placeholder="Describe this field..."
        />
      </div>
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Aliases</label>
        <Input
          value={((semantics.aliases as string[]) || []).join(", ")}
          onChange={(e) => onSave({ ...decorators, semantics: { ...semantics, aliases: e.target.value.split(",").map(s => s.trim()).filter(Boolean) } })}
          placeholder="Comma-separated aliases"
          className="h-8"
        />
      </div>
    </div>
  );
}

function ClassificationTab({ decorators, onSave }: { decorators: Record<string, unknown>; onSave: (d: Record<string, unknown>) => void }) {
  const classification = (decorators.classification || {}) as Record<string, unknown>;
  return (
    <div className="space-y-space-3">
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Level</label>
        <select
          value={(classification.level as string) || ""}
          onChange={(e) => onSave({ ...decorators, classification: { ...classification, level: e.target.value || undefined } })}
          className="w-full h-8 bg-muted rounded-lg px-space-3 text-body-small text-foreground outline-none border border-border"
        >
          <option value="">None</option>
          <option value="PII">PII</option>
          <option value="SENSITIVE">SENSITIVE</option>
          <option value="INTERNAL">INTERNAL</option>
          <option value="PUBLIC">PUBLIC</option>
        </select>
      </div>
    </div>
  );
}

function PolicyTab({ decorators, onSave }: { decorators: Record<string, unknown>; onSave: (d: Record<string, unknown>) => void }) {
  const policy = (decorators.policy || {}) as Record<string, unknown>;
  return (
    <div className="space-y-space-3">
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Retention</label>
        <Input value={(policy.retention as string) || ""} onChange={(e) => onSave({ ...decorators, policy: { ...policy, retention: e.target.value } })} placeholder="e.g., 7 years" className="h-8" />
      </div>
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Anonymization</label>
        <Input value={(policy.anonymization as string) || ""} onChange={(e) => onSave({ ...decorators, policy: { ...policy, anonymization: e.target.value } })} placeholder="e.g., hash, mask" className="h-8" />
      </div>
      <div>
        <label className="text-body-small text-foreground mb-space-1 block font-medium">Encryption</label>
        <Input value={(policy.encryption as string) || ""} onChange={(e) => onSave({ ...decorators, policy: { ...policy, encryption: e.target.value } })} placeholder="e.g., AES-256" className="h-8" />
      </div>
    </div>
  );
}

function EvolutionTab({ decorators, onSave }: { decorators: Record<string, unknown>; onSave: (d: Record<string, unknown>) => void }) {
  const evolution = (decorators.evolution || {}) as Record<string, unknown>;
  return (
    <div className="space-y-space-3">
      <label className="flex items-center gap-space-2 text-body-small">
        <input type="checkbox" checked={!!evolution.deprecated} onChange={(e) => onSave({ ...decorators, evolution: { ...evolution, deprecated: e.target.checked } })} className="accent-primary" />
        Deprecated
      </label>
      {!!evolution.deprecated && (
        <>
          <div>
            <label className="text-body-small text-foreground mb-space-1 block font-medium">Since</label>
            <Input value={(evolution.since as string) || ""} onChange={(e) => onSave({ ...decorators, evolution: { ...evolution, since: e.target.value } })} placeholder="e.g., v2.0" className="h-8" />
          </div>
          <div>
            <label className="text-body-small text-foreground mb-space-1 block font-medium">Replacement</label>
            <Input value={(evolution.replacement as string) || ""} onChange={(e) => onSave({ ...decorators, evolution: { ...evolution, replacement: e.target.value } })} placeholder="Replacement field name" className="h-8" />
          </div>
        </>
      )}
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <div className="text-body-small text-muted-foreground py-space-4 text-center">
      {name} configuration will be available in a future update.
    </div>
  );
}
