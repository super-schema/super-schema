"use client";

/**
 * GlossaryBrowser
 *
 * Main business glossary client component.
 * Left column: domain filter tabs + search input.
 * Main area: concept cards in a grid, click to expand detail panel.
 */

import { useState, useCallback, useEffect } from "react";
import type { BusinessConcept, FieldConceptLink } from "@/generated/prisma/client";
import { ConceptCard } from "./ConceptCard";
import { ConceptDetailPanel } from "./ConceptDetailPanel";
import { CreateConceptDialog } from "./CreateConceptDialog";
import {
  getConceptsAction,
  createConceptAction,
  deleteConceptAction,
  unlinkFieldFromConceptAction,
} from "@/app/(dashboard)/glossary/actions";
import type { CreateBusinessConceptInput } from "@/types/schemas/business-concept";

type ConceptWithLinks = BusinessConcept & { fieldLinks: FieldConceptLink[] };

const DOMAIN_TABS = ["All", "Core", "Finance", "Healthcare", "Identity", "Commerce", "Analytics"];

export function GlossaryBrowser() {
  const [concepts, setConcepts] = useState<ConceptWithLinks[]>([]);
  const [activeDomain, setActiveDomain] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedConceptId, setSelectedConceptId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadConcepts = useCallback(async () => {
    setLoading(true);
    const filters: Record<string, string> = {};
    if (activeDomain !== "All") filters.domain = activeDomain;
    if (searchQuery.trim()) filters.search = searchQuery.trim();

    const result = await getConceptsAction(filters);
    if ("data" in result && result.data) {
      setConcepts(result.data as ConceptWithLinks[]);
    }
    setLoading(false);
  }, [activeDomain, searchQuery]);

  useEffect(() => {
    loadConcepts();
  }, [loadConcepts]);

  const handleCreate = useCallback(
    async (input: CreateBusinessConceptInput) => {
      const result = await createConceptAction(input);
      if ("error" in result && result.error) {
        return { error: result.error };
      }
      await loadConcepts();
    },
    [loadConcepts]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deleteConceptAction(id);
      if ("error" in result && result.error) {
        return;
      }
      setSelectedConceptId(null);
      await loadConcepts();
    },
    [loadConcepts]
  );

  const handleUnlink = useCallback(
    async (fieldId: string, conceptId: string) => {
      await unlinkFieldFromConceptAction(fieldId, conceptId);
      await loadConcepts();
    },
    [loadConcepts]
  );

  const getConceptUsage = useCallback(
    async (conceptId: string) => {
      const concept = concepts.find((c) => c.id === conceptId);
      if (!concept) return null;
      // Return a simplified usage structure for the detail panel
      return {
        concept,
        usageCount: concept.fieldLinks?.length ?? 0,
        fields: [] as { fieldId: string; fieldName: string; entityName: string; domainName: string; confidence: number }[],
      };
    },
    [concepts]
  );

  // Derive unique domain values from concepts for "dynamic" tabs
  const allDomains = new Set(concepts.map((c) => c.domain));
  const domainTabs = DOMAIN_TABS.filter(
    (d) => d === "All" || allDomains.has(d)
  );
  // Add any domains from data that aren't in the default list
  for (const d of allDomains) {
    if (!domainTabs.includes(d)) {
      domainTabs.push(d);
    }
  }

  return (
    <div data-testid="glossary-browser" className="flex h-full">
      {/* Left sidebar: domain filter + search */}
      <div className="w-56 border-r border-border p-4 space-y-4 flex-shrink-0">
        <div>
          <h3 className="text-caption font-medium text-foreground mb-2">Domains</h3>
          <div className="space-y-0.5">
            {domainTabs.map((domain) => {
              const count =
                domain === "All"
                  ? concepts.length
                  : concepts.filter((c) => c.domain === domain).length;
              return (
                <button
                  key={domain}
                  type="button"
                  onClick={() => setActiveDomain(domain)}
                  className={`w-full text-left px-3 py-1.5 rounded text-caption transition-colors ${
                    activeDomain === domain
                      ? "text-foreground bg-primary/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  }`}
                >
                  {domain}
                  <span className="float-right text-mono-small opacity-60">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-caption font-medium text-foreground mb-1">
            Search
          </label>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search concepts..."
            className="w-full px-3 py-1.5 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          className="w-full px-3 py-2 rounded text-caption font-medium text-white"
          style={{
            background: "linear-gradient(135deg, #A477B2, #8B5CF6)",
          }}
        >
          + New Concept
        </button>
      </div>

      {/* Main area: concept grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center h-full text-caption text-muted-foreground">
            Loading concepts...
          </div>
        ) : concepts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-caption text-muted-foreground space-y-2">
            <p>No business concepts found.</p>
            <p className="text-mono-small">
              {searchQuery || activeDomain !== "All"
                ? "Try adjusting your filters."
                : "Create your first concept to get started."}
            </p>
          </div>
        ) : (
          <div className={`${selectedConceptId ? "flex gap-4" : ""}`}>
            <div
              className={`grid gap-3 ${
                selectedConceptId
                  ? "grid-cols-1 w-1/2"
                  : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
              }`}
            >
              {concepts.map((concept) => (
                <ConceptCard
                  key={concept.id}
                  concept={concept}
                  isSelected={selectedConceptId === concept.id}
                  onClick={() =>
                    setSelectedConceptId(
                      selectedConceptId === concept.id ? null : concept.id
                    )
                  }
                />
              ))}
            </div>

            {/* Detail panel */}
            {selectedConceptId && (
              <div className="w-1/2 border-l border-border pl-4">
                <ConceptDetailPanel
                  conceptId={selectedConceptId}
                  onClose={() => setSelectedConceptId(null)}
                  onUnlink={handleUnlink}
                  getUsage={getConceptUsage}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <CreateConceptDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onSubmit={handleCreate}
      />
    </div>
  );
}
