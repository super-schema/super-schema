"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DATA_TYPE_HIERARCHY, getTypesByCategory } from "@/lib/data-types";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import {
  buildMappingMatrixRows,
  getMappingsForTarget,
  summarizeMappingHealth,
  type MappingRiskSeverity,
} from "@/lib/type-mapping/mapping-intelligence";

// Show every schema-technology target that has a defined logical→physical type
// mapping. DB DDL targets (spanner, postgresql, bigquery) emit via the TypeSpec
// route now (source "typespec-official"), but their type mappings are engine-
// agnostic and still documented here — so filter by mapping coverage, not source.
const TARGETS = getSchemaTargetCatalog().filter(
  (target) =>
    target.enabledInSchemaTab && getMappingsForTarget(target.key).length > 0
);
const TARGET_KEYS = TARGETS.map((target) => target.key);
const TYPE_CATEGORIES = getTypesByCategory();
const DEFAULT_TYPE_ID = DATA_TYPE_HIERARCHY.find((type) => type.id === "int32")?.id ?? DATA_TYPE_HIERARCHY[0]?.id ?? "string";

const RISK_BADGE_VARIANT: Record<MappingRiskSeverity, "success" | "info" | "warning" | "destructive"> = {
  safe: "success",
  low: "info",
  medium: "warning",
  high: "destructive",
  critical: "destructive",
};

const RISK_ICON_CLASS: Record<MappingRiskSeverity, string> = {
  safe: "text-success",
  low: "text-info",
  medium: "text-warning",
  high: "text-destructive",
  critical: "text-destructive",
};

export function TypeMappingReference() {
  const [query, setQuery] = useState("");
  const [selectedTypeId, setSelectedTypeId] = useState(DEFAULT_TYPE_ID);

  const selectedType = useMemo(
    () => DATA_TYPE_HIERARCHY.find((type) => type.id === selectedTypeId) ?? DATA_TYPE_HIERARCHY[0],
    [selectedTypeId]
  );

  const filteredCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return TYPE_CATEGORIES.map(({ category, types }) => ({
      category,
      types: normalizedQuery
        ? types.filter(
            (type) =>
              type.id.toLowerCase().includes(normalizedQuery) ||
              type.label.toLowerCase().includes(normalizedQuery) ||
              type.description.toLowerCase().includes(normalizedQuery)
          )
        : types,
    })).filter(({ types }) => types.length > 0);
  }, [query]);

  const selectedRow = useMemo(
    () =>
      buildMappingMatrixRows({
        fields: [
          {
            id: selectedType.id,
            name: selectedType.label,
            type: selectedType.id,
            precision: selectedType.requiresPrecision ? 19 : null,
            scale: selectedType.requiresScale ? 4 : null,
          },
        ],
        targets: TARGET_KEYS,
      })[0],
    [selectedType]
  );

  const selectedMappings = useMemo(
    () => TARGETS.map((target) => selectedRow.cells[target.key]),
    [selectedRow]
  );
  const summary = useMemo(
    () => summarizeMappingHealth(selectedMappings),
    [selectedMappings]
  );

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <header className="flex flex-col gap-space-4 rounded-2xl border border-border/50 bg-muted/10 p-space-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="mb-space-2 inline-flex items-center gap-2 rounded-full border border-border/50 bg-background px-3 py-1 text-caption text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            Logical → physical type catalog
          </div>
          <h1 className="text-display text-foreground">Type Mapping Reference</h1>
          <p className="mt-space-2 text-body text-muted-foreground">
            Pick a Super Schema logical type and see exactly how it maps to each supported Super Schema native schema technology, with examples and data-quality warnings.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-space-2 text-caption" data-testid="mapping-summary">
          <Badge variant="success">{summary.safe} safe</Badge>
          <Badge variant={summary.risky > 0 ? "warning" : "success"}>{summary.risky} risky</Badge>
          <Badge variant={summary.unmapped > 0 ? "destructive" : "success"}>{summary.unmapped} unmapped</Badge>
        </div>
      </header>

      <div className="grid gap-space-4 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-xl border border-border/50 bg-background p-space-4">
          <label className="text-caption font-medium uppercase tracking-wider text-muted-foreground" htmlFor="type-mapping-search">
            Logical type
          </label>
          <div className="relative mt-space-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="type-mapping-search"
              role="searchbox"
              aria-label="Search logical types"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search logical types..."
              className="h-9 pl-9"
            />
          </div>

          <div className="mt-space-4 max-h-[calc(100vh-280px)] space-y-space-4 overflow-y-auto pr-1">
            {filteredCategories.map(({ category, types }) => (
              <section key={category} aria-label={`${category} types`}>
                <h2 className="mb-space-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {category}
                </h2>
                <div className="space-y-1">
                  {types.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      aria-pressed={selectedType.id === type.id}
                      onClick={() => setSelectedTypeId(type.id)}
                      className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                        selectedType.id === type.id
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-space-2">
                        <span className="font-mono text-body-small font-medium">{type.label}</span>
                        {selectedType.id === type.id && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-caption">{type.description}</p>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {filteredCategories.length === 0 && (
              <p className="rounded-lg border border-border/50 bg-muted/20 px-3 py-4 text-caption text-muted-foreground" aria-live="polite">
                No logical types match that search.
              </p>
            )}
          </div>
        </aside>

        <main className="space-y-space-4">
          <section className="rounded-xl border border-border/50 bg-background p-space-5">
            <div className="flex flex-wrap items-start justify-between gap-space-3">
              <div>
                <div className="flex flex-wrap items-center gap-space-2">
                  <h2 className="text-heading-1 text-foreground">{selectedType.label}</h2>
                  <Badge variant="outline">{selectedType.category}</Badge>
                  <Badge variant="secondary">TypeSpec {selectedType.typespecScalar}</Badge>
                </div>
                <p className="mt-space-2 max-w-2xl text-body text-muted-foreground">
                  {selectedType.description}
                </p>
              </div>
              {selectedType.example && (
                <div className="rounded-lg border border-border/50 bg-muted/20 px-space-3 py-space-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Example value</div>
                  <div className="mt-1 font-mono text-body-small text-foreground">{selectedType.example}</div>
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-border/50 bg-background">
            <div className="overflow-x-auto" tabIndex={0} aria-label="Scrollable type mapping table">
              <table className="w-full min-w-[820px] text-caption" aria-label={`Type mappings for ${selectedType.label}`}>
                <thead>
                  <tr className="border-b border-border/50 bg-muted/30">
                    <th scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">Technology</th>
                    <th scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">Maps to</th>
                    <th scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">Health</th>
                    <th scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">Example / possible problems</th>
                    <th scope="col" className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-foreground/80">Mitigation</th>
                </tr>
              </thead>
              <tbody>
                {TARGETS.map((target, index) => {
                  const cell = selectedRow.cells[target.key];
                  const risk = cell.risk;
                  return (
                    <tr
                      key={target.key}
                      data-testid="type-mapping-row"
                      data-target={target.key}
                      className={index % 2 === 0 ? "" : "bg-muted/10"}
                    >
                      <td className="px-3 py-3 align-top">
                        <div className="font-medium text-foreground">{target.displayName}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">{target.outputLanguage}</div>
                      </td>
                      <td className="px-3 py-3 align-top">
                        <div className="font-mono text-body-small text-primary" data-testid="mapped-type">{cell.mapping.mappedType}</div>
                        {cell.targetType?.description && (
                          <p className="mt-1 max-w-[220px] text-[10px] text-muted-foreground">{cell.targetType.description}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        <Badge variant={RISK_BADGE_VARIANT[risk.severity]} data-testid="mapping-health" data-severity={risk.severity}>
                          {risk.severity === "safe" ? (
                            <CheckCircle2 className={`h-3 w-3 ${RISK_ICON_CLASS[risk.severity]}`} />
                          ) : (
                            <AlertTriangle className={`h-3 w-3 ${RISK_ICON_CLASS[risk.severity]}`} />
                          )}
                          {risk.label}
                        </Badge>
                        {cell.mapping.lossDescription && (
                          <p className="mt-1 max-w-[220px] text-[10px] text-muted-foreground">{cell.mapping.lossDescription}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {(risk.exampleBefore || risk.exampleAfter) && (
                          <div className="mb-space-2 rounded-md bg-muted/20 px-2 py-1 font-mono text-[10px] text-foreground">
                            {risk.exampleBefore && <div>Logical: {risk.exampleBefore}</div>}
                            {risk.exampleAfter && <div>Target: {risk.exampleAfter}</div>}
                          </div>
                        )}
                        {risk.possibleProblems.length > 0 ? (
                          <ul className="max-w-[320px] list-disc space-y-1 pl-4 text-[10px] text-muted-foreground">
                            {risk.possibleProblems.map((problem) => (
                              <li key={problem}>{problem}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="max-w-[320px] text-[10px] text-muted-foreground">Preserves the logical value shape for normal use.</p>
                        )}
                      </td>
                      <td className="px-3 py-3 align-top">
                        {risk.mitigations.length > 0 ? (
                          <ul className="max-w-[300px] list-disc space-y-1 pl-4 text-[10px] text-muted-foreground">
                            {risk.mitigations.map((mitigation) => (
                              <li key={mitigation}>{mitigation}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-[10px] text-muted-foreground">No action needed.</p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
