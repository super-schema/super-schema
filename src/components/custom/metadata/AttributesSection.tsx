"use client";
import { Button } from "@/components/ui/button";
import { AttributeKeyCombobox } from "@/components/custom/metadata/AttributeKeyCombobox";
import { AttributeValueEditor, initialAttributeValue } from "@/components/custom/metadata/AttributeValueEditor";
import type { MetadataAttributeDefinition, MetadataAttributeTarget } from "@/types/schemas/metadata-attribute";

interface Props {
  /** What is being edited: only the definitions that list this target are offered. */
  target: MetadataAttributeTarget;
  /** The tenant's dictionary. */
  definitions: readonly MetadataAttributeDefinition[];
  /** The item's stored extension map (`x-…` key → JSON value). */
  extensions: Readonly<Record<string, unknown>> | undefined;
  /** Called with the whole next map on every edit; `undefined` when the last attribute was removed. */
  onChange: (next: Record<string, unknown> | undefined) => void;
  readOnly?: boolean;
}

/**
 * The "Metadata" section of an API operation, event channel, message or event operation: dictionary attributes of the target with typed
 * editors; stored `x-…` keys the dictionary does not define for it are listed as they are, and can be removed. Controlled and free of
 * persistence: the host decides how the map is saved.
 */
export function AttributesSection({ target, definitions, extensions, onChange, readOnly = false }: Props) {
  const defs = definitions.filter((d) => d.targets.includes(target));
  const stored: Readonly<Record<string, unknown>> = extensions ?? {};
  const defined = new Set(defs.map((d) => d.key));
  const raw = Object.entries(stored).filter(([key]) => !defined.has(key));
  if (defs.length === 0 && raw.length === 0) return null;

  const present = defs.filter((d) => Object.hasOwn(stored, d.key));

  function set(key: string, value: unknown | undefined) {
    const next: Record<string, unknown> = { ...stored };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  }

  return (
    <section aria-label="Metadata" data-testid={`attributes-${target}`} className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-space-3">
      <h3 className="text-sm font-semibold">Metadata</h3>
      {present.map((d) => (
        <div key={d.key} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="text-sm font-medium">{d.label}</span> <code className="break-all text-xs text-muted-foreground">{d.key}</code>
            </div>
            {!readOnly && (
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${d.label}`} onClick={() => set(d.key, undefined)}>
                Remove
              </Button>
            )}
          </div>
          <AttributeValueEditor
            schema={d.valueSchema}
            value={stored[d.key]}
            derivedKeys={Object.keys(d.derive ?? {})}
            label={d.label}
            hideLabel
            disabled={readOnly}
            onChange={(v) => set(d.key, v)}
          />
        </div>
      ))}
      {raw.map(([key, value]) => (
        <div key={key} className="min-w-0 rounded-md border border-border p-2">
          <div className="flex items-start justify-between gap-2">
            <code className="break-all text-xs">{key}</code>
            {!readOnly && (
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${key}`} onClick={() => set(key, undefined)}>
                Remove
              </Button>
            )}
          </div>
          <pre className="whitespace-pre-wrap break-all text-xs text-muted-foreground">{JSON.stringify(value)}</pre>
        </div>
      ))}
      {defs.filter((d) => d.requiredWhen === "always" && !Object.hasOwn(stored, d.key)).map((d) => (
        <p key={d.key} role="status" className="text-xs text-warning">
          {d.label} ({d.key}) is required here.
        </p>
      ))}
      {!readOnly && defs.length > 0 && (
        <AttributeKeyCombobox
          definitions={defs}
          existingKeys={Object.keys(stored)}
          allowFreeKey={false}
          onPick={(key, def) => {
            if (def) set(key, initialAttributeValue(def));
          }}
        />
      )}
    </section>
  );
}
