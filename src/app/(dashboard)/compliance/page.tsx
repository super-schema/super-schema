"use client";

import { useState, useCallback, useEffect } from "react";
import { Shield } from "lucide-react";
import { createLatestRequestGuard } from "@/lib/latest-request";
import { ComplianceFilterSidebar } from "@/features/compliance/ComplianceFilterSidebar";
import { ComplianceResultsTable } from "@/features/compliance/ComplianceResultsTable";
import { ComplianceGapsView } from "@/features/compliance/ComplianceGapsView";
import { ComplianceExportPopover } from "@/features/compliance/ComplianceExportPopover";
import { AuditTrailView } from "@/features/compliance/AuditTrailView";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";
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
  const [error, setError] = useState<string | null>(null);

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

  // The latest request of each list: an older answer that arrives late must not replace a newer one (src/lib/latest-request.ts)
  // Made once per page (a lazy initial state, not a new object on every render); invalidated when the page unmounts, so an answer that comes
  // after it is dropped too.
  const [guards] = useState(() => ({ fields: createLatestRequestGuard(), gaps: createLatestRequestGuard(), audit: createLatestRequestGuard() }));
  useEffect(
    () => () => {
      guards.fields.invalidate();
      guards.gaps.invalidate();
      guards.audit.invalidate();
    },
    [guards],
  );

  // Audit trail state
  const [auditFilters, setAuditFilters] = useState<AuditTrailFilter>({});
  const [auditEntries, setAuditEntries] = useState<AuditTrailEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);

  // Fetch domains on mount
  useEffect(() => {
    fetch("/api/domains-tree")
      .then((res) => (res.ok ? res.json() : { domains: [] }))
      .then((data: ExplorerTree) =>
        setDomains(data.domains.map((d) => ({ id: d.id, name: d.name })))
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
  }, [activeTab]);

  // Fetch audit trail when switching to audit tab or filters change
  useEffect(() => {
    if (activeTab === "audit") {
      fetchAuditTrail();
    }
  }, [activeTab, auditFilters, auditPage]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchFields() {
    const isLatest = guards.fields.start();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters, pagination: { page, pageSize: 25, sortBy, sortOrder } }),
      });
      const data = await res.json().catch(() => null);
      // A newer request has been made (the filters changed again): this answer is stale, and the newer one sets the state.
      if (!isLatest()) return;
      if (res.ok && data?.success) {
        setFields(data.data.fields);
        setTotal(data.data.total);
      } else {
        setError(data?.error || `Failed to load compliance data (${res.status})`);
      }
    } catch {
      if (isLatest()) setError("Network error — could not reach the compliance service.");
    } finally {
      if (isLatest()) setLoading(false);
    }
  }

  async function fetchGaps() {
    const isLatest = guards.gaps.start();
    setGapsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {} }),
      });
      const data = await res.json().catch(() => null);
      if (!isLatest()) return;
      if (res.ok && data?.success) {
        setGaps(data.data.gaps);
        setGapSummary(data.data.summary);
      } else {
        setError(data?.error || `Failed to load gaps (${res.status})`);
      }
    } catch {
      if (isLatest()) setError("Network error — could not reach the compliance service.");
    } finally {
      if (isLatest()) setGapsLoading(false);
    }
  }

  async function fetchAuditTrail() {
    const isLatest = guards.audit.start();
    setAuditLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/compliance/audit-trail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: auditFilters, pagination: { page: auditPage, pageSize: 50 } }),
      });
      const data = await res.json().catch(() => null);
      if (!isLatest()) return;
      if (res.ok && data?.success) {
        setAuditEntries(data.data.entries);
        setAuditTotal(data.data.total);
      } else {
        setError(data?.error || `Failed to load audit trail (${res.status})`);
      }
    } catch {
      if (isLatest()) setError("Network error — could not reach the compliance service.");
    } finally {
      if (isLatest()) setAuditLoading(false);
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

      {error && (
        <div
          role="alert"
          data-testid="compliance-error"
          className="mx-space-6 mt-space-4 rounded-md border border-destructive/40 bg-destructive/10 px-space-4 py-space-3 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

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
