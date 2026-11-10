"use client";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import type {
  Documentation,
  Versioning,
} from "@/types/schemas/typespec-decorator.schema";

export function VersioningPanel({
  versioning: v,
  versions = [],
  onChange,
  documentation = {},
  onDocumentationChange,
  discriminator,
  onDiscriminatorChange,
}: {
  versioning: Versioning;
  versions?: string[];
  onChange: (v: Versioning) => void;
  documentation?: Documentation;
  onDocumentationChange?: (v: Documentation) => void;
  discriminator?: boolean;
  onDiscriminatorChange?: (v: boolean) => void;
}) {
  const id = useId();
  function update(patch: Partial<Versioning>) {
    onChange({ ...v, ...patch });
  }
  return (
    <FieldGroup>
      <FieldDescription>
        Schema evolution annotations describe when a field changed. They are
        distinct from the audit log and published version history. Enter a
        version label or select a known one.
      </FieldDescription>
      <datalist id={id}>
        {versions.map((version) => (
          <option key={version} value={version} />
        ))}
      </datalist>
      {(["added", "removed", "madeOptional", "madeRequired"] as const).map(
        (key) => (
          <AttributeControl
            key={key}
            label={
              {
                added: "Added in version",
                removed: "Removed in version",
                madeOptional: "Made optional in version",
                madeRequired: "Made required in version",
              }[key]
            }
          >
            <Input
              list={id}
              value={v[key] ?? ""}
              onChange={(e) => update({ [key]: e.target.value || null })}
              spellCheck={false}
            />
          </AttributeControl>
        ),
      )}
      <AttributeControl label="Renamed in version">
        <Input
          list={id}
          value={v.renamedFrom?.version ?? ""}
          onChange={(e) =>
            update({
              renamedFrom: e.target.value
                ? {
                    version: e.target.value,
                    oldName: v.renamedFrom?.oldName ?? "",
                  }
                : null,
            })
          }
        />
      </AttributeControl>
      {v.renamedFrom && (
        <AttributeControl label="Previous field name">
          <Input
            value={v.renamedFrom.oldName}
            onChange={(e) =>
              update({
                renamedFrom: { ...v.renamedFrom!, oldName: e.target.value },
              })
            }
          />
        </AttributeControl>
      )}
      <AttributeControl label="Type changed in version">
        <Input
          list={id}
          value={v.typeChangedFrom?.version ?? ""}
          onChange={(e) =>
            update({
              typeChangedFrom: e.target.value
                ? {
                    version: e.target.value,
                    oldType: v.typeChangedFrom?.oldType ?? "string",
                  }
                : null,
            })
          }
        />
      </AttributeControl>
      {v.typeChangedFrom && (
        <AttributeControl
          label="Previous type"
          help="A TypeSpec scalar or declared type name."
        >
          <Input
            value={v.typeChangedFrom.oldType}
            onChange={(e) =>
              update({
                typeChangedFrom: {
                  ...v.typeChangedFrom!,
                  oldType: e.target.value,
                },
              })
            }
            spellCheck={false}
          />
        </AttributeControl>
      )}
      {onDocumentationChange && (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              checked={documentation.deprecated != null}
              onChange={(e) =>
                onDocumentationChange({
                  ...documentation,
                  deprecated: e.target.checked ? "" : null,
                })
              }
            />
            <span>Deprecated</span>
          </label>
          {documentation.deprecated != null && (
            <AttributeControl label="Deprecation reason and replacement">
              <Input
                value={documentation.deprecated}
                onChange={(e) =>
                  onDocumentationChange({
                    ...documentation,
                    deprecated: e.target.value,
                  })
                }
              />
            </AttributeControl>
          )}
        </>
      )}
      {onDiscriminatorChange && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={discriminator ?? false}
            onChange={(e) => onDiscriminatorChange(e.target.checked)}
          />
          <span>
            Use this field as the entity discriminator
            <span className="block text-xs text-muted-foreground">
              Select one string property to distinguish model variants. The
              annotation is emitted on the entity model.
            </span>
          </span>
        </label>
      )}
    </FieldGroup>
  );
}
