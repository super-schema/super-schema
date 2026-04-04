"use client";

import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import type { Versioning } from "@/types/schemas/typespec-decorator.schema";

interface VersioningPanelProps {
  versioning: Versioning;
  versions?: string[];
  onChange: (versioning: Versioning) => void;
}

export function VersioningPanel({
  versioning,
  versions,
  onChange,
}: VersioningPanelProps) {
  function update(partial: Partial<Versioning>) {
    onChange({ ...versioning, ...partial });
  }

  // If no versions available, show message
  if (!versions || versions.length === 0) {
    return (
      <div className="py-space-2 text-body-small text-muted-foreground/60 italic">
        Enable versioning on the domain to use version-aware decorators.
        Configure version enums in domain settings to unlock @added, @removed,
        and other versioning decorators.
      </div>
    );
  }

  function VersionSelect({
    value,
    onChange: onVersionChange,
    placeholder,
  }: {
    value: string | null | undefined;
    onChange: (val: string | null) => void;
    placeholder: string;
  }) {
    return (
      <select
        value={value ?? ""}
        onChange={(e) => onVersionChange(e.target.value || null)}
        className="h-7 rounded border border-border bg-background px-2 text-body-small text-foreground w-32"
      >
        <option value="">{placeholder}</option>
        {versions!.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Version timeline */}
      <div>
        <label className="text-caption text-muted-foreground mb-2 block">
          Version Timeline
        </label>
        <div className="flex items-center gap-1">
          {versions.map((v) => {
            const isAdded = versioning.added === v;
            const isRemoved = versioning.removed === v;
            return (
              <div
                key={v}
                className={`px-2 py-1 rounded text-[10px] font-mono border cursor-default ${
                  isAdded
                    ? "border-success bg-success/10 text-success"
                    : isRemoved
                      ? "border-destructive bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground"
                }`}
                title={
                  isAdded
                    ? `Added in ${v}`
                    : isRemoved
                      ? `Removed in ${v}`
                      : v
                }
              >
                {v}
              </div>
            );
          })}
        </div>
      </div>

      {/* @added */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @added
        </label>
        <VersionSelect
          value={versioning.added}
          onChange={(val) => update({ added: val })}
          placeholder="Select version"
        />
      </div>

      {/* @removed */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @removed
        </label>
        <VersionSelect
          value={versioning.removed}
          onChange={(val) => update({ removed: val })}
          placeholder="Select version"
        />
      </div>

      {/* @renamedFrom */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @renamedFrom
        </label>
        <VersionSelect
          value={versioning.renamedFrom?.version ?? null}
          onChange={(val) =>
            update({
              renamedFrom: val
                ? {
                    version: val,
                    oldName: versioning.renamedFrom?.oldName ?? "",
                  }
                : null,
            })
          }
          placeholder="Select version"
        />
        {versioning.renamedFrom && (
          <Input
            value={versioning.renamedFrom.oldName}
            onChange={(e) =>
              update({
                renamedFrom: {
                  version: versioning.renamedFrom!.version,
                  oldName: e.target.value,
                },
              })
            }
            placeholder="Old field name"
            className="h-7 text-body-small font-mono w-40"
          />
        )}
      </div>

      {/* @madeOptional */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @madeOptional
        </label>
        <VersionSelect
          value={versioning.madeOptional}
          onChange={(val) => update({ madeOptional: val })}
          placeholder="Select version"
        />
      </div>

      {/* @madeRequired */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @madeRequired
        </label>
        <VersionSelect
          value={versioning.madeRequired}
          onChange={(val) => update({ madeRequired: val })}
          placeholder="Select version"
        />
      </div>

      {/* @typeChangedFrom */}
      <div className="flex items-center gap-space-3">
        <label className="text-caption text-muted-foreground w-28">
          @typeChangedFrom
        </label>
        <VersionSelect
          value={versioning.typeChangedFrom?.version ?? null}
          onChange={(val) =>
            update({
              typeChangedFrom: val
                ? {
                    version: val,
                    oldType: versioning.typeChangedFrom?.oldType ?? "string",
                  }
                : null,
            })
          }
          placeholder="Select version"
        />
        {versioning.typeChangedFrom && (
          <TypePicker
            value={versioning.typeChangedFrom.oldType}
            onChange={(t) =>
              update({
                typeChangedFrom: {
                  version: versioning.typeChangedFrom!.version,
                  oldType: t,
                },
              })
            }
            compact
          />
        )}
      </div>
    </div>
  );
}
