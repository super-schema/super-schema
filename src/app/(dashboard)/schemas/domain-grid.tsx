"use client";

import { useState, useMemo } from "react";
import { Search, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DomainCard } from "@/components/custom/DomainCard";
import { createDomainAction } from "./actions";

interface DomainData {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  entityCount: number;
  createdAt: Date;
}

interface DomainGridProps {
  domains: DomainData[];
}

export function DomainGrid({ domains }: DomainGridProps) {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return domains;
    const q = search.toLowerCase();
    return domains.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q)
    );
  }, [domains, search]);

  async function handleCreate(formData: FormData) {
    setCreateError(null);
    setIsCreating(true);
    const result = await createDomainAction(formData);
    setIsCreating(false);
    if (result.error) {
      setCreateError(result.error);
    } else {
      setShowCreate(false);
    }
  }

  return (
    <div className="animate-auth-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-space-6">
        <div>
          <h1 className="text-display text-foreground">Domains</h1>
          <p className="text-body text-muted-foreground mt-space-1">
            Select a domain to manage its logical entities
          </p>
        </div>
        <Button
          onClick={() => setShowCreate(true)}
          className="gap-2"
        >
          <Plus className="w-4 h-4" />
          Create Domain
        </Button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-space-2 mb-space-6 max-w-md">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search domains..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
      </div>

      {/* Create Domain Dialog (inline) */}
      {showCreate && (
        <div className="surface-glass rounded-xl border border-primary/20 p-space-6 mb-space-6">
          <h3 className="text-heading-2 text-foreground mb-space-4">
            Create New Domain
          </h3>
          <form action={handleCreate} className="space-y-space-4">
            <div>
              <label className="text-body-small text-foreground mb-space-1 block font-medium">
                Name
              </label>
              <Input
                name="name"
                placeholder="e.g., Customer, Payment, Compliance"
                required
                maxLength={64}
                autoFocus
                className="h-9"
              />
            </div>
            <div>
              <label className="text-body-small text-foreground mb-space-1 block font-medium">
                Description
              </label>
              <Input
                name="description"
                placeholder="Brief description of this domain"
                className="h-9"
              />
            </div>
            {createError && (
              <p className="text-body-small text-destructive">{createError}</p>
            )}
            <div className="flex gap-space-2">
              <Button type="submit" disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowCreate(false);
                  setCreateError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Domain Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-heading-2 text-foreground mb-space-2">
            No domains found
          </p>
          <p className="text-body text-muted-foreground">
            {search
              ? "Try a different search term"
              : "Create your first domain to get started"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
          {filtered.map((domain) => (
            <DomainCard key={domain.id} {...domain} />
          ))}
        </div>
      )}
    </div>
  );
}
