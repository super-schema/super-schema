"use client";

import { useState, useRef, useEffect } from "react";
import { Download, FileText, Table, Loader2 } from "lucide-react";
import { exportToCsv } from "./exportCsv";
import type { ComplianceFieldResult, ComplianceGap, ComplianceFilter } from "@/types/schemas/compliance";

interface ComplianceExportPopoverProps {
  fields: ComplianceFieldResult[];
  gaps?: ComplianceGap[];
  filters: ComplianceFilter;
  activeTab: "query" | "gaps" | "audit";
  loading?: boolean;
}

export function ComplianceExportPopover({
  fields,
  gaps,
  filters,
  activeTab,
  loading: externalLoading,
}: ComplianceExportPopoverProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      if (activeTab === "gaps" && gaps) {
        exportGapsCsv(gaps, filters);
      } else {
        exportToCsv(fields, filters);
      }
    } finally {
      setExporting(false);
      setOpen(false);
    }
  };

  const handleExportJson = async () => {
    setExporting(true);
    try {
      const data = activeTab === "gaps" && gaps ? gaps : fields;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = generateFilename(filters, "json");
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={externalLoading || exporting}
        className="flex items-center gap-space-2 px-space-3 py-1.5 text-body-small border border-border rounded-lg hover:bg-accent/50 transition-colors disabled:opacity-50"
      >
        {exporting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        Export
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 surface-1 border border-border rounded-xl shadow-lg backdrop-blur-sm z-50 overflow-hidden">
          <button
            onClick={handleExportCsv}
            className="w-full flex items-center gap-space-3 px-space-4 py-space-3 hover:bg-accent/50 transition-colors text-left"
          >
            <Table className="w-5 h-5 text-green-400" />
            <div>
              <div className="text-body-small font-medium">CSV</div>
              <div className="text-caption text-muted-foreground">
                Tabular data for spreadsheets
              </div>
            </div>
          </button>
          <button
            onClick={handleExportJson}
            className="w-full flex items-center gap-space-3 px-space-4 py-space-3 hover:bg-accent/50 transition-colors text-left border-t border-border"
          >
            <FileText className="w-5 h-5 text-blue-400" />
            <div>
              <div className="text-body-small font-medium">JSON</div>
              <div className="text-caption text-muted-foreground">
                Structured data format
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

function exportGapsCsv(
  gaps: ComplianceGap[],
  filters: ComplianceFilter
) {
  const headers = [
    "Entity Name",
    "Field Name",
    "Gap Type",
    "Severity",
    "Suggested Fix",
  ];
  const rows = gaps.map((g) => [
    g.entityName,
    g.fieldName,
    g.gapType,
    g.severity,
    g.suggestedFix,
  ]);

  const csv = [
    headers.join(","),
    ...rows.map((r) => r.map((v) => `"${(v || "").replace(/"/g, '""')}"`).join(",")),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = generateFilename(filters, "csv");
  a.click();
  URL.revokeObjectURL(url);
}

function generateFilename(
  filters: ComplianceFilter,
  ext: string
): string {
  const date = new Date().toISOString().split("T")[0];
  const filterParts = [
    ...(filters.classifications || []),
    filters.retention && filters.retention !== "any"
      ? filters.retention
      : null,
    filters.anonymization && filters.anonymization !== "any"
      ? filters.anonymization
      : null,
  ].filter(Boolean);
  const filterSuffix =
    filterParts.length > 0 ? `-${filterParts.join("-").toLowerCase()}` : "";
  return `compliance-report-${date}${filterSuffix}.${ext}`;
}
