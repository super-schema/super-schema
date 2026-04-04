import { useState, useCallback, useMemo } from "react";
import type { DiffField } from "@/services/version-history/version.types";

export type SortKey = "fieldName" | "changeType";
export type SortDirection = "asc" | "desc";

const CHANGE_TYPE_ORDER: Record<string, number> = {
  added: 0,
  modified: 1,
  removed: 2,
  unchanged: 3,
};

export function useDiffViewer(fields: DiffField[]) {
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("changeType");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const toggleExpand = useCallback((fieldName: string) => {
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    const modifiedFieldNames = fields
      .filter((f) => f.changeType === "modified")
      .map((f) => f.fieldName);
    setExpandedFields(new Set(modifiedFieldNames));
  }, [fields]);

  const collapseAll = useCallback(() => {
    setExpandedFields(new Set());
  }, []);

  const isExpanded = useCallback(
    (fieldName: string) => expandedFields.has(fieldName),
    [expandedFields]
  );

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDirection("asc");
      }
    },
    [sortKey]
  );

  const sortedFields = useMemo(() => {
    const sorted = [...fields];
    sorted.sort((a, b) => {
      let cmp: number;
      if (sortKey === "fieldName") {
        cmp = a.fieldName.localeCompare(b.fieldName);
      } else {
        cmp = CHANGE_TYPE_ORDER[a.changeType] - CHANGE_TYPE_ORDER[b.changeType];
        if (cmp === 0) {
          cmp = a.fieldName.localeCompare(b.fieldName);
        }
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });
    return sorted;
  }, [fields, sortKey, sortDirection]);

  return {
    sortedFields,
    sortKey,
    sortDirection,
    handleSort,
    isExpanded,
    toggleExpand,
    expandAll,
    collapseAll,
  };
}
