"use client";

import { useState, useCallback, useEffect } from "react";
import { Search, X } from "lucide-react";
import type { ComplianceFilter } from "@/types/schemas/compliance";

const CLASSIFICATIONS = ["PII", "SENSITIVE", "INTERNAL", "PUBLIC"];

const RETENTION_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "lt_1_year", label: "< 1 year" },
  { value: "1_to_3_years", label: "1-3 years" },
  { value: "3_to_7_years", label: "3-7 years" },
  { value: "gt_7_years", label: "> 7 years" },
];

const ANONYMIZATION_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "none", label: "None" },
  { value: "hash", label: "Hash" },
  { value: "mask", label: "Mask" },
  { value: "redact", label: "Redact" },
  { value: "pseudonymize", label: "Pseudonymize" },
];

const ENCRYPTION_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "none", label: "None" },
  { value: "AES-256", label: "AES-256" },
  { value: "field-level", label: "Field-level" },
];

interface ComplianceFilterSidebarProps {
  filters: ComplianceFilter;
  onFilterChange: (filters: ComplianceFilter) => void;
  domains: { id: string; name: string }[];
}

export function ComplianceFilterSidebar({
  filters,
  onFilterChange,
  domains,
}: ComplianceFilterSidebarProps) {
  const [textSearch, setTextSearch] = useState(filters.textSearch || "");

  // Debounced text search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (textSearch !== (filters.textSearch || "")) {
        onFilterChange({ ...filters, textSearch });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [textSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleClassification = useCallback(
    (cls: string) => {
      const current = filters.classifications || [];
      const next = current.includes(cls)
        ? current.filter((c) => c !== cls)
        : [...current, cls];
      onFilterChange({ ...filters, classifications: next });
    },
    [filters, onFilterChange]
  );

  const toggleDomain = useCallback(
    (domainId: string) => {
      const current = filters.domains || [];
      const next = current.includes(domainId)
        ? current.filter((d) => d !== domainId)
        : [...current, domainId];
      onFilterChange({ ...filters, domains: next });
    },
    [filters, onFilterChange]
  );

  const clearAll = useCallback(() => {
    setTextSearch("");
    onFilterChange({});
  }, [onFilterChange]);

  return (
    <div
      data-testid="compliance-filter-sidebar"
      className="w-[280px] min-w-[280px] surface-1 border-r border-border p-space-4 overflow-y-auto flex flex-col gap-space-4"
    >
      {/* Text Search */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Search
        </label>
        <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search entities, fields..."
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
          />
        </div>
      </div>

      {/* Classification */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Classification
        </label>
        <div className="flex flex-col gap-space-1">
          {CLASSIFICATIONS.map((cls) => (
            <label
              key={cls}
              className="flex items-center gap-space-2 text-body-small cursor-pointer hover:bg-accent/50 rounded px-space-2 py-1"
            >
              <input
                type="checkbox"
                checked={(filters.classifications || []).includes(cls)}
                onChange={() => toggleClassification(cls)}
                className="accent-primary"
              />
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-caption font-medium ${
                  cls === "PII"
                    ? "bg-red-500/20 text-red-400"
                    : cls === "SENSITIVE"
                      ? "bg-amber-500/20 text-amber-400"
                      : cls === "INTERNAL"
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-green-500/20 text-green-400"
                }`}
              >
                {cls}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Retention */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Retention
        </label>
        <select
          value={filters.retention || "any"}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              retention: e.target.value as ComplianceFilter["retention"],
            })
          }
          className="w-full bg-muted text-foreground text-body-small rounded-lg px-space-3 py-1.5 border border-border outline-none"
        >
          {RETENTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Anonymization */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Anonymization
        </label>
        <select
          value={filters.anonymization || "any"}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              anonymization: e.target.value as ComplianceFilter["anonymization"],
            })
          }
          className="w-full bg-muted text-foreground text-body-small rounded-lg px-space-3 py-1.5 border border-border outline-none"
        >
          {ANONYMIZATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Encryption */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Encryption
        </label>
        <select
          value={filters.encryption || "any"}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              encryption: e.target.value as ComplianceFilter["encryption"],
            })
          }
          className="w-full bg-muted text-foreground text-body-small rounded-lg px-space-3 py-1.5 border border-border outline-none"
        >
          {ENCRYPTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Domain */}
      <div>
        <label className="text-caption text-muted-foreground uppercase tracking-wider block mb-space-2">
          Domains
        </label>
        <div className="flex flex-col gap-space-1 max-h-40 overflow-y-auto">
          {domains.map((domain) => (
            <label
              key={domain.id}
              className="flex items-center gap-space-2 text-body-small cursor-pointer hover:bg-accent/50 rounded px-space-2 py-1"
            >
              <input
                type="checkbox"
                checked={(filters.domains || []).includes(domain.id)}
                onChange={() => toggleDomain(domain.id)}
                className="accent-primary"
              />
              <span>{domain.name}</span>
            </label>
          ))}
          {domains.length === 0 && (
            <span className="text-caption text-muted-foreground">
              No domains available
            </span>
          )}
        </div>
      </div>

      {/* Clear All */}
      <button
        onClick={clearAll}
        className="flex items-center justify-center gap-space-2 text-body-small text-muted-foreground hover:text-foreground border border-border rounded-lg px-space-3 py-1.5 hover:bg-accent/50 transition-colors mt-auto"
      >
        <X className="w-4 h-4" />
        Clear all filters
      </button>
    </div>
  );
}
