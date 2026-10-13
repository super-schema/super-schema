"use client";

import { useState, useEffect, useCallback } from "react";
import { Search, Plus, CheckCircle, Circle, RefreshCw, X } from "lucide-react";
import {
  getDomainsAdminAction,
  createDomainAdminAction,
} from "@/app/(dashboard)/admin/actions";

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
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // create form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getDomainsAdminAction();
    if ("error" in res) {
      setError(res.error ?? "Request failed");
      setLoading(false);
      return;
    }
    setDomains(
      res.data.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        entityCount: d.entityCount,
        policyTemplateStatus: d.policyTemplateStatus,
        createdAt: new Date(d.createdAt).toLocaleDateString(),
      }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    // Fetch once on mount; state updates occur after the async result resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function openCreate() {
    setNewName("");
    setNewDescription("");
    setCreateError(null);
    setShowCreateDialog(true);
  }

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError("Domain name is required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    const res = await createDomainAdminAction({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
    });
    if ("error" in res) {
      setCreateError(res.error ?? "Request failed");
      setCreating(false);
      return;
    }
    setCreating(false);
    setShowCreateDialog(false);
    await load();
  }

  const filtered = domains.filter(
    (d) => !search.trim() || d.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-space-4">
      {error && (
        <div
          role="alert"
          data-testid="domain-error"
          className="rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
        >
          {error}
        </div>
      )}

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
          onClick={openCreate}
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
            {loading ? (
              <tr>
                <td colSpan={5} className="px-space-4 py-space-6 text-center text-muted-foreground">
                  <span className="inline-flex items-center gap-space-2">
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Loading domains…
                  </span>
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-space-4 py-space-6 text-center text-muted-foreground">
                  {search ? "No matching domains" : "No domains yet. Create one to get started."}
                </td>
              </tr>
            ) : (
              filtered.map((domain) => (
                <tr
                  key={domain.id}
                  className="border-b border-border last:border-0 hover:bg-accent/50 transition-colors"
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

      {/* Create dialog */}
      {showCreateDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-space-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-domain-title"
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowCreateDialog(false);
          }}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-space-5 shadow-lg">
            <div className="flex items-center justify-between mb-space-4">
              <h3 id="create-domain-title" className="text-heading-4 text-foreground">
                Create Domain
              </h3>
              <button
                onClick={() => setShowCreateDialog(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {createError && (
              <div
                role="alert"
                className="mb-space-3 rounded-md border border-destructive bg-destructive/5 px-space-3 py-space-2 text-body-small text-destructive"
              >
                {createError}
              </div>
            )}

            <div className="space-y-space-3">
              <div>
                <label className="block text-body-small text-foreground mb-1" htmlFor="domain-name">
                  Name
                </label>
                <input
                  id="domain-name"
                  type="text"
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-space-3 py-1.5 text-body-small text-foreground outline-none focus:border-primary"
                  placeholder="e.g. Payments"
                />
              </div>
              <div>
                <label className="block text-body-small text-foreground mb-1" htmlFor="domain-description">
                  Description
                </label>
                <textarea
                  id="domain-description"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-border bg-background px-space-3 py-1.5 text-body-small text-foreground outline-none focus:border-primary"
                  placeholder="Optional description"
                />
              </div>
            </div>

            <div className="mt-space-5 flex items-center justify-end gap-space-2">
              <button
                onClick={() => setShowCreateDialog(false)}
                disabled={creating}
                className="px-space-3 py-1.5 rounded-md border border-border text-body-small text-foreground hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small disabled:opacity-50"
              >
                {creating && <RefreshCw className="w-4 h-4 animate-spin" />}
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
