"use client";

import { useState, useCallback, useEffect, useTransition } from "react";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChangeTimeline } from "@/components/custom/ChangeTimeline";
import type {
  TimelineEntry,
  ChangeType,
  ChangeHistoryFilters,
} from "@/types/schemas/change-history";

// --- Filter bar types ---

const CHANGE_TYPE_OPTIONS: { value: ChangeType | "all"; label: string }[] = [
  { value: "all", label: "All Changes" },
  { value: "version", label: "Versions" },
  { value: "field_edit", label: "Field Changes" },
  { value: "status_change", label: "Status Changes" },
  { value: "decorator_change", label: "Decorator Changes" },
  { value: "emission", label: "Emissions" },
  { value: "governance", label: "Governance" },
];

// --- Props ---

export interface ChangeHistoryViewProps {
  entityId: string;
  fetchHistory: (
    entityId: string,
    filters?: ChangeHistoryFilters,
    cursor?: string
  ) => Promise<{
    entries?: TimelineEntry[];
    hasMore?: boolean;
    nextCursor?: string;
    error?: string;
  }>;
  onViewDiff?: (versionNumber: number, previousVersion: number) => void;
}

export function ChangeHistoryView({
  entityId,
  fetchHistory,
  onViewDiff,
}: ChangeHistoryViewProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [isPending, startTransition] = useTransition();
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Filter state
  const [selectedChangeType, setSelectedChangeType] = useState<
    ChangeType | "all"
  >("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filtersVisible, setFiltersVisible] = useState(false);

  const buildFilters = useCallback((): ChangeHistoryFilters | undefined => {
    const filters: ChangeHistoryFilters = {};
    let hasFilters = false;

    if (selectedChangeType !== "all") {
      filters.changeTypes = [selectedChangeType];
      hasFilters = true;
    }

    if (dateFrom) {
      filters.dateFrom = new Date(dateFrom);
      hasFilters = true;
    }

    if (dateTo) {
      filters.dateTo = new Date(dateTo + "T23:59:59");
      hasFilters = true;
    }

    return hasFilters ? filters : undefined;
  }, [selectedChangeType, dateFrom, dateTo]);

  const loadHistory = useCallback(
    (resetEntries = true) => {
      startTransition(async () => {
        const filters = buildFilters();
        const result = await fetchHistory(
          entityId,
          filters,
          resetEntries ? undefined : nextCursor
        );

        if (result.entries) {
          if (resetEntries) {
            setEntries(result.entries);
          } else {
            setEntries((prev) => [...prev, ...result.entries!]);
          }
          setHasMore(result.hasMore ?? false);
          setNextCursor(result.nextCursor);
        }
      });
    },
    [entityId, fetchHistory, buildFilters, nextCursor]
  );

  // Initial load
  useEffect(() => {
    loadHistory(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  // Reload when filters change
  useEffect(() => {
    loadHistory(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChangeType, dateFrom, dateTo]);

  const handleLoadMore = useCallback(() => {
    setIsLoadingMore(true);
    loadHistory(false);
    setIsLoadingMore(false);
  }, [loadHistory]);

  const handleViewDiff = useCallback(
    (versionNumber: number) => {
      if (onViewDiff && versionNumber > 1) {
        onViewDiff(versionNumber, versionNumber - 1);
      }
    },
    [onViewDiff]
  );

  const clearFilters = useCallback(() => {
    setSelectedChangeType("all");
    setDateFrom("");
    setDateTo("");
  }, []);

  const hasActiveFilters =
    selectedChangeType !== "all" || dateFrom !== "" || dateTo !== "";

  return (
    <div className="animate-auth-fade-up" data-testid="change-history-view">
      {/* Header */}
      <div className="flex items-center justify-between mb-space-4">
        <h2 className="text-heading-2 text-foreground">Change History</h2>

        <div className="flex items-center gap-space-2">
          <Button
            variant={filtersVisible ? "secondary" : "outline"}
            size="sm"
            onClick={() => setFiltersVisible(!filtersVisible)}
            className="gap-1.5"
          >
            <Filter className="w-3.5 h-3.5" />
            Filters
            {hasActiveFilters && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            )}
          </Button>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="gap-1"
            >
              <X className="w-3 h-3" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      {filtersVisible && (
        <div
          className="flex flex-wrap items-center gap-space-3 mb-space-4 p-space-3 rounded-lg border border-border/50 bg-muted/20"
          data-testid="filter-bar"
        >
          {/* Change Type filter */}
          <div className="flex items-center gap-space-2">
            <label className="text-caption text-muted-foreground whitespace-nowrap">
              Type:
            </label>
            <select
              value={selectedChangeType}
              onChange={(e) =>
                setSelectedChangeType(e.target.value as ChangeType | "all")
              }
              className="h-8 rounded-md border border-border bg-background px-2 text-body-small text-foreground focus:outline-none focus:border-ring"
              data-testid="filter-change-type"
            >
              {CHANGE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date From filter */}
          <div className="flex items-center gap-space-2">
            <label className="text-caption text-muted-foreground whitespace-nowrap">
              From:
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-body-small text-foreground focus:outline-none focus:border-ring"
              data-testid="filter-date-from"
            />
          </div>

          {/* Date To filter */}
          <div className="flex items-center gap-space-2">
            <label className="text-caption text-muted-foreground whitespace-nowrap">
              To:
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-body-small text-foreground focus:outline-none focus:border-ring"
              data-testid="filter-date-to"
            />
          </div>
        </div>
      )}

      {/* Loading state */}
      {isPending && entries.length === 0 && (
        <div className="flex justify-center py-8">
          <span className="text-body-small text-muted-foreground">
            Loading history...
          </span>
        </div>
      )}

      {/* Timeline */}
      <ChangeTimeline
        entries={entries}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={handleLoadMore}
        onViewDiff={handleViewDiff}
      />
    </div>
  );
}
