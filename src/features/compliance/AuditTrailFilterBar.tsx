"use client";

import { useState, useEffect } from "react";
import { Download, X, Search, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AuditTrailFilter } from "@/types/schemas/compliance";
import {
  dayAfterStart,
  dayInputValue,
  dayStart,
  lastDayInputValue,
  withDateBound,
} from "./audit-date-range";

import { NativeSelect } from "@/components/ui/native-select";
const ACTION_TYPES = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "REORDER",
  "annotation.create",
  "annotation.resolve",
  "compliance.query",
  "compliance.export",
];

const ENTITY_TYPES = [
  "Entity",
  "Field",
  "Domain",
  "Annotation",
];

interface AuditTrailFilterBarProps {
  filters: AuditTrailFilter;
  onFilterChange: (filters: AuditTrailFilter) => void;
  onExport: () => void;
  /** An export is being made: the Export button is off until it is made */
  exporting?: boolean;
}

export function AuditTrailFilterBar({
  filters,
  onFilterChange,
  onExport,
  exporting = false,
}: AuditTrailFilterBarProps) {
  const [entityName, setEntityName] = useState(filters.entityName || "");

  useEffect(() => {
    const timer = setTimeout(() => {
      if (entityName !== (filters.entityName || "")) {
        onFilterChange({ ...filters, entityName: entityName || undefined });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [entityName]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="flex items-center gap-space-3 px-space-4 py-space-3 border-b border-border flex-wrap"
      data-testid="audit-trail-filter-bar"
    >
      {/* Action type filter */}
      <NativeSelect
        data-testid="audit-filter-action"
        aria-label="Action"
        value={filters.actionTypes?.[0] || ""}
        onChange={(e) =>
          onFilterChange({
            ...filters,
            actionTypes: e.target.value ? [e.target.value] : [],
          })
        }
      >
        <option value="">All Actions</option>
        {ACTION_TYPES.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </NativeSelect>

      {/* Entity type filter */}
      <NativeSelect
        data-testid="audit-filter-type"
        aria-label="Entity type"
        value={filters.entityType || ""}
        onChange={(e) =>
          onFilterChange({
            ...filters,
            entityType: e.target.value || undefined,
          })
        }
      >
        <option value="">All Types</option>
        {ENTITY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </NativeSelect>

      {/* Entity name search */}
      <div className="flex items-center gap-space-1 bg-muted rounded-lg px-space-3 py-1.5 border border-border">
        <Search className="w-3 h-3 text-muted-foreground" />
        <input
          type="text"
          data-testid="audit-filter-entity"
          aria-label="Entity name or id"
          placeholder="Entity name..."
          value={entityName}
          onChange={(e) => setEntityName(e.target.value)}
          className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-32"
        />
      </div>

      {/* Date range: whole local days, both ends included (see audit-date-range.ts); a bound that is left out is not invented */}
      <input
        type="date"
        value={dayInputValue(filters.dateRange?.from)}
        onChange={(e) =>
          onFilterChange({ ...filters, dateRange: withDateBound(filters.dateRange, { from: dayStart(e.target.value) }) })
        }
        className="bg-muted text-foreground text-body-small rounded-lg px-space-3 py-1.5 border border-border outline-none"
        placeholder="From"
      />
      <input
        type="date"
        value={lastDayInputValue(filters.dateRange?.to)}
        onChange={(e) =>
          onFilterChange({ ...filters, dateRange: withDateBound(filters.dateRange, { to: dayAfterStart(e.target.value) }) })
        }
        className="bg-muted text-foreground text-body-small rounded-lg px-space-3 py-1.5 border border-border outline-none"
        placeholder="To"
      />

      {/* Clear */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setEntityName("");
          onFilterChange({});
        }}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="w-3 h-3" />
        Clear
      </Button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Export */}
      <Button
        variant="outline"
        data-testid="audit-export"
        onClick={onExport}
        disabled={exporting}
      >
        {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        Export Audit Trail
      </Button>
    </div>
  );
}
