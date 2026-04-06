"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Box,
  List,
  Hash,
  GitBranch,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TypeSpecImportReviewScreenProps {
  importResult: TypeSpecImportResult;
  domains: { id: string; name: string }[];
  suggestedDomainName?: string;
  onConfirm: (
    domainId: string,
    selectedEntities: number[],
    selectedEnums: number[],
    selectedScalars: number[],
    selectedUnions: number[]
  ) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TypeSpecImportReviewScreen({
  importResult,
  domains,
  suggestedDomainName,
  onConfirm,
  onCancel,
}: TypeSpecImportReviewScreenProps) {
  // Domain selection — pre-fill from namespace if matching domain exists
  const suggestedDomain = suggestedDomainName
    ? domains.find((d) => d.name.toLowerCase() === suggestedDomainName.toLowerCase())
    : null;
  const [selectedDomainId, setSelectedDomainId] = useState(
    suggestedDomain?.id ?? domains[0]?.id ?? ""
  );

  // Selection state — all selected by default
  const [selectedEntities, setSelectedEntities] = useState<Set<number>>(
    new Set(importResult.entities.map((_, i) => i))
  );
  const [selectedEnums, setSelectedEnums] = useState<Set<number>>(
    new Set(importResult.sharedEnums.map((_, i) => i))
  );
  const [selectedScalars, setSelectedScalars] = useState<Set<number>>(
    new Set(importResult.customScalars.map((_, i) => i))
  );
  const [selectedUnions, setSelectedUnions] = useState<Set<number>>(
    new Set(importResult.unions.map((_, i) => i))
  );

  // Expandable sections
  const [expandedEntities, setExpandedEntities] = useState<Set<number>>(new Set());

  function toggleEntity(idx: number) {
    const next = new Set(selectedEntities);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelectedEntities(next);
  }

  function toggleEnum(idx: number) {
    const next = new Set(selectedEnums);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelectedEnums(next);
  }

  function toggleScalar(idx: number) {
    const next = new Set(selectedScalars);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelectedScalars(next);
  }

  function toggleUnion(idx: number) {
    const next = new Set(selectedUnions);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelectedUnions(next);
  }

  function toggleEntityExpand(idx: number) {
    const next = new Set(expandedEntities);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setExpandedEntities(next);
  }

  const totalSelected =
    selectedEntities.size + selectedEnums.size + selectedScalars.size + selectedUnions.size;

  function handleConfirm() {
    onConfirm(
      selectedDomainId,
      [...selectedEntities],
      [...selectedEnums],
      [...selectedScalars],
      [...selectedUnions]
    );
  }

  return (
    <div className="space-y-space-4" data-testid="typespec-import-review">
      {/* Header */}
      <div>
        <h3 className="text-heading-3 text-foreground">Review TypeSpec Import</h3>
        <p className="text-caption text-muted-foreground mt-1">
          {importResult.entities.length} model(s),{" "}
          {importResult.sharedEnums.length} enum(s),{" "}
          {importResult.customScalars.length} scalar(s),{" "}
          {importResult.unions.length} union(s)
          {importResult.namespace && (
            <span className="ml-1">
              from namespace <span className="text-foreground font-medium">{importResult.namespace}</span>
            </span>
          )}
        </p>
      </div>

      {/* Domain selector */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Target Domain</label>
        <select
          value={selectedDomainId}
          onChange={(e) => setSelectedDomainId(e.target.value)}
          className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {suggestedDomain?.id === d.id ? " (from namespace)" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Warnings */}
      {importResult.warnings.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 space-y-1">
          {importResult.warnings.map((w, i) => (
            <p key={i} className="text-caption text-muted-foreground">{w}</p>
          ))}
        </div>
      )}

      {/* Models section */}
      {importResult.entities.length > 0 && (
        <div>
          <h4 className="text-body-small font-medium text-foreground flex items-center gap-1.5 mb-2">
            <Box className="w-3.5 h-3.5" />
            Models ({importResult.entities.length})
          </h4>
          <div className="space-y-1">
            {importResult.entities.map((entity, idx) => (
              <div key={idx} className="rounded-lg border border-border/50">
                <div className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedEntities.has(idx)}
                    onChange={() => toggleEntity(idx)}
                    className="rounded"
                  />
                  <button
                    onClick={() => toggleEntityExpand(idx)}
                    className="p-0.5 rounded hover:bg-accent"
                  >
                    {expandedEntities.has(idx) ? (
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    )}
                  </button>
                  <span className="text-body-small font-medium text-foreground">{entity.name}</span>
                  <Badge variant="secondary" className="text-[10px] h-4">
                    {entity.fields.length} fields
                  </Badge>
                  {entity.description && (
                    <span className="text-caption text-muted-foreground truncate flex-1">
                      {entity.description}
                    </span>
                  )}
                </div>
                {expandedEntities.has(idx) && (
                  <div className="px-10 pb-2 space-y-0.5">
                    {entity.fields.map((f, fi) => (
                      <div key={fi} className="text-caption text-muted-foreground flex items-center gap-2">
                        <span className="font-mono">{f.name}</span>
                        <span className="text-muted-foreground/50">{f.type}</span>
                        {f.isKey && <Badge variant="outline" className="text-[9px] h-3.5">key</Badge>}
                        {!f.nullable && <Badge variant="outline" className="text-[9px] h-3.5">required</Badge>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enums section */}
      {importResult.sharedEnums.length > 0 && (
        <div>
          <h4 className="text-body-small font-medium text-foreground flex items-center gap-1.5 mb-2">
            <List className="w-3.5 h-3.5" />
            Enums ({importResult.sharedEnums.length})
          </h4>
          <div className="space-y-1">
            {importResult.sharedEnums.map((e, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                <input type="checkbox" checked={selectedEnums.has(idx)} onChange={() => toggleEnum(idx)} className="rounded" />
                <span className="text-body-small font-medium text-foreground">{e.name}</span>
                <span className="text-caption text-muted-foreground">{e.values.join(", ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scalars section */}
      {importResult.customScalars.length > 0 && (
        <div>
          <h4 className="text-body-small font-medium text-foreground flex items-center gap-1.5 mb-2">
            <Hash className="w-3.5 h-3.5" />
            Custom Scalars ({importResult.customScalars.length})
          </h4>
          <div className="space-y-1">
            {importResult.customScalars.map((s, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                <input type="checkbox" checked={selectedScalars.has(idx)} onChange={() => toggleScalar(idx)} className="rounded" />
                <span className="text-body-small font-medium text-foreground">{s.name}</span>
                <span className="text-caption text-muted-foreground">extends {s.baseType}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unions section */}
      {importResult.unions.length > 0 && (
        <div>
          <h4 className="text-body-small font-medium text-foreground flex items-center gap-1.5 mb-2">
            <GitBranch className="w-3.5 h-3.5" />
            Unions ({importResult.unions.length})
          </h4>
          <div className="space-y-1">
            {importResult.unions.map((u, idx) => (
              <div key={idx} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2">
                <input type="checkbox" checked={selectedUnions.has(idx)} onChange={() => toggleUnion(idx)} className="rounded" />
                <span className="text-body-small font-medium text-foreground">{u.name}</span>
                <span className="text-caption text-muted-foreground">{u.memberTypes.join(" | ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-space-3 border-t border-border/50">
        <span className="text-caption text-muted-foreground">
          {totalSelected} item(s) selected
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedDomainId || totalSelected === 0}
            className="gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Import {totalSelected} Item(s)
          </Button>
        </div>
      </div>
    </div>
  );
}
