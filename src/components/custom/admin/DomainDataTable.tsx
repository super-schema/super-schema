"use client";

import { useState } from "react";
import { Search, Plus, CheckCircle, Circle } from "lucide-react";

interface DomainRow {
  id: string;
  name: string;
  description: string;
  entityCount: number;
  policyTemplateStatus: "Configured" | "No template";
  createdAt: string;
}

export function DomainDataTable() {
  const [search, setSearch] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const domains: DomainRow[] = [];

  const filtered = domains.filter(
    (d) =>
      !search.trim() || d.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-space-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-space-2 max-w-sm flex-1">
          <div className="flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 flex-1">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Filter domains..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-body-small text-foreground placeholder:text-muted-foreground outline-none w-full"
            />
          </div>
        </div>
        <button
          onClick={() => setShowCreateDialog(true)}
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small"
        >
          <Plus className="w-4 h-4" />
          Create Domain
        </button>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-body-small">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Name</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Description</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Entities</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Policy Template</th>
              <th className="text-left px-space-4 py-space-3 text-muted-foreground font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-space-4 py-space-6 text-center text-muted-foreground">
                  {search ? "No matching domains" : "No domains yet. Create one to get started."}
                </td>
              </tr>
            ) : (
              filtered.map((domain) => (
                <tr
                  key={domain.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
                >
                  <td className="px-space-4 py-space-3 text-foreground font-medium">{domain.name}</td>
                  <td className="px-space-4 py-space-3 text-muted-foreground truncate max-w-xs">{domain.description}</td>
                  <td className="px-space-4 py-space-3 text-foreground">{domain.entityCount}</td>
                  <td className="px-space-4 py-space-3">
                    {domain.policyTemplateStatus === "Configured" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption bg-success/20 text-success">
                        <CheckCircle className="w-3 h-3" />
                        Configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption bg-muted text-muted-foreground">
                        <Circle className="w-3 h-3" />
                        No template
                      </span>
                    )}
                  </td>
                  <td className="px-space-4 py-space-3 text-muted-foreground">{domain.createdAt}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
