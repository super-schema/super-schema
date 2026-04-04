"use client";

import { useState, useCallback, useEffect } from "react";
import { Shield } from "lucide-react";
import { ComplianceFilterSidebar } from "@/features/compliance/ComplianceFilterSidebar";
import { ComplianceResultsTable } from "@/features/compliance/ComplianceResultsTable";
import { ComplianceGapsView } from "@/features/compliance/ComplianceGapsView";
import { ComplianceExportPopover } from "@/features/compliance/ComplianceExportPopover";
import { AuditTrailView } from "@/features/compliance/AuditTrailView";
import type {
  ComplianceFilter,
  ComplianceFieldResult,
  ComplianceGap,
  GapSummary,
  AuditTrailFilter,
  AuditTrailEntry,
} from "@/types/schemas/compliance";

type TabId = "query" | "gaps" | "audit";

const TABS: { id: TabId; label: string }[] = [
  { id: "query", label: "Query" },
  { id: "gaps", label: "Gaps" },
  { id: "audit", label: "Audit Trail" },
];

export default function CompliancePage() {
  const [activeTab, setActiveTab] = useState<TabId>("query");

  // Query tab state
  const [filters, setFilters] = useState<ComplianceFilter>({});
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState("entityName");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [fields, setFields] = useState<ComplianceFieldResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [domains, setDomains] = useState<{ id: string; name: string }[]>([]);

  // Gaps tab state
  const [gaps, setGaps] = useState<ComplianceGap[]>([]);
  const [gapSummary, setGapSummary] = useState<GapSummary>({
    criticalCount: 0,
    warningCount: 0,
    affectedEntityCount: 0,
    countsByGapType: {},
  });
  const [gapsLoading, setGapsLoading] = useState(false);

  // Audit trail state
  const [auditFilters, setAuditFilters] = useState<AuditTrailFilter>({});
  const [auditEntries, setAuditEntries] = useState<AuditTrailEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);

  // Fetch domains on mount
  useEffect(() => {
    fetch("/api/domains-tree")
      .then((res) => (res.ok ? res.json() : []))
      .then((data) =>
        setDomains(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data.map((d: any) => ({ id: d.id, name: d.name }))
        )
      )
      .catch(() => setDomains([]));
  }, []);

  // Fetch fields when filters/sort/page change (query tab)
  useEffect(() => {
    if (activeTab !== "query") return;
    const timer = setTimeout(() => {
      fetchFields();
    }, 300);
    return () => clearTimeout(timer);
  }, [filters, page, sortBy, sortOrder, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch gaps when switching to gaps tab
  useEffect(() => {
    if (activeTab === "gaps") {
      fetchGaps();
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch audit trail when switching to audit tab or filters change
  useEffect(() => {
    if (activeTab === "audit") {
      fetchAuditTrail();
    }
  }, [activeTab, auditFilters, auditPage]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchFields() {
    setLoading(true);
    try {
      const res = await fetch("/api/compliance/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters, pagination: { page, pageSize: 25, sortBy, sortOrder } }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setFields(data.data.fields);
          setTotal(data.data.total);
        }
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }

  async function fetchGaps() {
    setGapsLoading(true);
    try {
      const res = await fetch("/api/compliance/gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {} }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setGaps(data.data.gaps);
          setGapSummary(data.data.summary);
        }
      }
    } catch {
      // silently fail
    } finally {
      setGapsLoading(false);
    }
  }

  async function fetchAuditTrail() {
    setAuditLoading(true);
    try {
      const res = await fetch("/api/compliance/audit-trail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: auditFilters, pagination: { page: auditPage, pageSize: 50 } }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setAuditEntries(data.data.entries);
          setAuditTotal(data.data.total);
        }
      }
    } catch {
      // silently fail
    } finally {
      setAuditLoading(false);
    }
  }

  const handleSort = useCallback(
    (column: string) => {
      if (sortBy === column) {
        setSortOrder(sortOrder === "asc" ? "desc" : "asc");
      } else {
        setSortBy(column);
        setSortOrder("asc");
      }
      setPage(1);
    },
    [sortBy, sortOrder]
  );

  const handleFilterChange = useCallback((newFilters: ComplianceFilter) => {
    setFilters(newFilters);
    setPage(1);
  }, []);

  const handleAuditExport = useCallback(() => {
    const headers = [
      "Timestamp",
      "User",
      "Action",
      "Entity Type",
      "Entity ID",
      "Change Summary",
    ];
    const rows = auditEntries.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.userName || "",
      e.action,
      e.entityType,
      e.entityId,
      e.changeSummary,
    ]);
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        r.map((v) => `"${(v || "").replace(/"/g, '""')}"`).join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-trail-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [auditEntries]);

  return (
    <div className="flex flex-col h-full -m-space-6" data-testid="compliance-page">
      {/* Header */}
      <div className="flex items-center justify-between px-space-6 py-space-4 border-b border-border">
        <div className="flex items-center gap-space-3">
          <Shield className="w-5 h-5 text-primary" />
          <h1 className="text-heading-2 font-semibold">Compliance</h1>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-space-1 bg-muted rounded-lg p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-space-3 py-1 text-body-small rounded-md transition-colors ${
                activeTab === tab.id
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Export (for query/gaps tabs) */}
        {(activeTab === "query" || activeTab === "gaps") && (
          <ComplianceExportPopover
            fields={fields}
            gaps={activeTab === "gaps" ? gaps : undefined}
            filters={filters}
            activeTab={activeTab}
            loading={loading}
          />
        )}
        {activeTab === "audit" && <div />}
      </div>

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Query tab */}
        {activeTab === "query" && (
          <>
            <ComplianceFilterSidebar
              filters={filters}
              onFilterChange={handleFilterChange}
              domains={domains}
            />
            <ComplianceResultsTable
              fields={fields}
              total={total}
              page={page}
              pageSize={25}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
              onPageChange={setPage}
              loading={loading}
            />
          </>
        )}

        {/* Gaps tab */}
        {activeTab === "gaps" && (
          <ComplianceGapsView
            gaps={gaps}
            summary={gapSummary}
            loading={gapsLoading}
          />
        )}

        {/* Audit Trail tab */}
        {activeTab === "audit" && (
          <AuditTrailView
            entries={auditEntries}
            total={auditTotal}
            page={auditPage}
            filters={auditFilters}
            onFilterChange={(f) => {
              setAuditFilters(f);
              setAuditPage(1);
            }}
            onPageChange={setAuditPage}
            onExport={handleAuditExport}
            loading={auditLoading}
          />
        )}
      </div>
    </div>
  );
}
