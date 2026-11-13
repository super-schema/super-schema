"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { AttributeKeyCombobox } from "@/components/custom/metadata/AttributeKeyCombobox";
import { AttributeValueEditor } from "@/components/custom/metadata/AttributeValueEditor";
import { readEntityAttributes } from "@/lib/metadata-attributes/values";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

interface Props {
  /** The entity's stored metadata (its attributes are `custom.extensions`). */
  metadata: Record<string, unknown> | null;
  /** The tenant's dictionary; only the entity-target definitions are used. */
  definitions: MetadataAttributeDefinition[];
  isReadOnly: boolean;
  /** Persists one attribute (`undefined` removes it). Resolves with an error message, or nothing on success. */
  onSave: (key: string, value: unknown | undefined) => Promise<{ error?: string } | void>;
}

function initialValue(def: MetadataAttributeDefinition): unknown {
  switch (def.valueSchema.type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "string":
      return "";
    default:
      return def.valueSchema.minimum ?? 0;
  }
}

/** The entity's "Metadata" section: dictionary attributes (target entity) with typed editors; other stored x- keys are shown raw. */
export function EntityAttributesSection({ metadata, definitions, isReadOnly, onSave }: Props) {
  const defs = definitions.filter((d) => d.targets.includes("entity"));
  const stored = readEntityAttributes(metadata);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (defs.length === 0) return null;

  const defined = new Set(defs.map((d) => d.key));
  const shown = (key: string) => (Object.hasOwn(drafts, key) ? drafts[key] : stored[key]);
  const present = defs.filter((d) => Object.hasOwn(stored, d.key) || Object.hasOwn(drafts, d.key));
  const raw = Object.entries(stored).filter(([key]) => !defined.has(key));

  async function save(key: string, value: unknown | undefined) {
    setBusy(true);
    setError(null);
    try {
      const result = await onSave(key, value);
      if (result && result.error) {
        setError(result.error);
        return;
      }
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Metadata" className="mb-space-4 flex min-w-0 flex-col gap-3 rounded-md border border-border p-space-3">
      <h2 className="text-sm font-semibold">Metadata</h2>
      {present.map((d) => (
        <div key={d.key} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="text-sm font-medium">{d.label}</span> <code className="break-all text-xs text-muted-foreground">{d.key}</code>
            </div>
            {!isReadOnly && (
              <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${d.label}`} onClick={() => void save(d.key, undefined)}>
                Remove
              </Button>
            )}
          </div>
          <AttributeValueEditor
            schema={d.valueSchema}
            value={shown(d.key)}
            derivedKeys={Object.keys(d.derive ?? {})}
            label={d.label}
            disabled={isReadOnly}
            onChange={(v) => setDrafts((cur) => ({ ...cur, [d.key]: v }))}
          />
          {!isReadOnly && Object.hasOwn(drafts, d.key) && (
            <Button type="button" size="sm" className="self-start" disabled={busy} aria-label={`Save ${d.label}`} onClick={() => void save(d.key, drafts[d.key])}>
              Save
            </Button>
          )}
        </div>
      ))}
      {raw.map(([key, value]) => (
        <div key={key} className="min-w-0 rounded-md border border-border p-2">
          <code className="break-all text-xs">{key}</code>
          <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(value)}</pre>
        </div>
      ))}
      {!isReadOnly && (
        <AttributeKeyCombobox
          definitions={defs}
          existingKeys={present.map((d) => d.key)}
          allowFreeKey={false}
          onPick={(key, def) => {
            if (def) setDrafts((cur) => ({ ...cur, [key]: initialValue(def) }));
          }}
        />
      )}
      {error && <FieldError>{error}</FieldError>}
    </section>
  );
}
