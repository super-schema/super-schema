"use client";

import { useState, useMemo } from "react";
import { pluralize } from "@/lib/pluralize";
import { Search, ArrowLeft } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  getAllStandards,
  searchStandards,
  getStandardsBySource,
  type StandardTemplate,
  type StandardSource,
} from "@/lib/schema-standards";

const SOURCE_TABS: { id: StandardSource | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "schema.org", label: "Schema.org" },
  { id: "financial", label: "Financial" },
  { id: "healthcare-fhir", label: "Healthcare" },
];

interface StandardsBrowserProps {
  onSelect: (template: StandardTemplate) => void;
  onBack: () => void;
}

export function StandardsBrowser({ onSelect, onBack }: StandardsBrowserProps) {
  const [activeTab, setActiveTab] = useState<StandardSource | "all">("all");
  const [query, setQuery] = useState("");

  const templates = useMemo(() => {
    let results: StandardTemplate[];

    if (activeTab === "all") {
      results = query.trim() ? searchStandards(query) : getAllStandards();
    } else {
      results = getStandardsBySource(activeTab);
      if (query.trim()) {
        const q = query.toLowerCase();
        results = results.filter(
          (t) =>
            t.entityName.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q)
        );
      }
    }

    return results;
  }, [activeTab, query]);

  return (
    <div className="space-y-space-4">
      {/* Back + Search */}
      <div className="flex items-center gap-space-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-body-small text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <div className="flex-1 flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search standards..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
            autoFocus
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex items-center gap-space-1 border-b border-border">
        {SOURCE_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-space-3 py-space-2 text-body-small transition-colors border-b-2 ${
              activeTab === tab.id
                ? "border-primary text-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Template cards */}
      {templates.length === 0 ? (
        <p className="text-body-small text-muted-foreground text-center py-space-6">
          No templates found{query ? ` for "${query}"` : ""}.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-3 max-h-[400px] overflow-y-auto pr-1">
          {templates.map((template) => (
            <button
              key={`${template.source}-${template.entityName}`}
              onClick={() => onSelect(template)}
              className="surface-glass rounded-lg border border-border/50 p-space-4 text-left hover:border-primary/40 hover:bg-accent/20 transition-all cursor-pointer"
            >
              <div className="flex items-start justify-between mb-space-2">
                <h4 className="text-body text-foreground font-medium">
                  {template.entityName}
                </h4>
                <Badge variant="secondary" className="text-[10px] h-4 px-1 shrink-0">
                  {template.source}
                </Badge>
              </div>
              <p className="text-caption text-muted-foreground line-clamp-2 mb-space-2">
                {template.description}
              </p>
              <span className="text-caption text-muted-foreground/60">
                {pluralize(template.fields.length, "field")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
