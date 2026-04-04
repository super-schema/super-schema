"use client";

import { useState } from "react";
import { AuditTrailFilterBar } from "./AuditTrailFilterBar";
import { AuditTrailList } from "./AuditTrailList";
import type { AuditTrailFilter, AuditTrailEntry } from "@/types/schemas/compliance";

interface AuditTrailViewProps {
  entries: AuditTrailEntry[];
  total: number;
  page: number;
  filters: AuditTrailFilter;
  onFilterChange: (filters: AuditTrailFilter) => void;
  onPageChange: (page: number) => void;
  onExport: () => void;
  loading: boolean;
}

export function AuditTrailView({
  entries,
  total,
  page,
  filters,
  onFilterChange,
  onPageChange,
  onExport,
  loading,
}: AuditTrailViewProps) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="audit-trail-view">
      <AuditTrailFilterBar
        filters={filters}
        onFilterChange={onFilterChange}
        onExport={onExport}
      />
      <AuditTrailList
        entries={entries}
        total={total}
        page={page}
        pageSize={50}
        onPageChange={onPageChange}
        loading={loading}
      />
    </div>
  );
}
