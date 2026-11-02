"use client";

import { useState, useRef, useEffect } from "react";
import { Download, FileText, Table, Loader2 } from "lucide-react";
import {
  exportFieldsToJson,
  exportGapsToCsv,
  exportGapsToJson,
  exportLimitNotice,
  exportToCsv,
} from "./exportCsv";
import type { ComplianceFieldResult, ComplianceGap, ComplianceFilter } from "@/types/schemas/compliance";

interface ComplianceExportPopoverProps {
  gaps?: ComplianceGap[];
  filters: ComplianceFilter;
  /** The sort of the Query list: the export comes out in the same order. */
  sortBy: string;
  sortOrder: "asc" | "desc";
  activeTab: "query" | "gaps" | "audit";
  loading?: boolean;
}

type Notice = { tone: "warning" | "error"; text: string };

/**
 * Every field the filters select, from the server (the page on the screen is not the export): `truncated` when the export stopped at the cap.
 */
async function fetchFieldExport(
  filters: ComplianceFilter,
  sortBy: string,
  sortOrder: "asc" | "desc"
): Promise<{ fields: ComplianceFieldResult[]; total: number; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch("/api/compliance/query/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters, sort: { sortBy, sortOrder } }),
    });
  } catch {
    throw new Error("Network error — the export did not run.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error || `The export failed (${res.status}).`);
  return data.data;
}

export function ComplianceExportPopover({
  gaps,
  filters,
  sortBy,
  sortOrder,
  activeTab,
  loading: externalLoading,
}: ComplianceExportPopoverProps) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
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

  const runExport = async (format: "csv" | "json") => {
    setExporting(true);
    setNotice(null);
    try {
      if (activeTab === "gaps" && gaps) {
        if (format === "csv") exportGapsToCsv(gaps, filters);
        else exportGapsToJson(gaps, filters);
      } else {
        const exported = await fetchFieldExport(filters, sortBy, sortOrder);
        if (format === "csv") exportToCsv(exported.fields, filters);
        else exportFieldsToJson(exported.fields, filters);
        if (exported.truncated) setNotice({ tone: "warning", text: exportLimitNotice(exported.total, "matching fields") });
      }
    } catch (e: unknown) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The export did not run." });
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
            onClick={() => runExport("csv")}
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
            onClick={() => runExport("json")}
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

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          data-testid="compliance-export-notice"
          className={`absolute right-0 top-full mt-1 w-80 rounded-md border px-space-3 py-space-2 text-caption shadow-lg z-50 ${
            notice.tone === "error"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-background text-foreground"
          }`}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
