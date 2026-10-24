"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Plus, Database, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DomainCard } from "@/components/custom/DomainCard";
import { DomainDeletionDialog } from "@/components/custom/DomainDeletionDialog";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { DomainDeletionImpact } from "@/types/domain-deletion";
import { createDomainAction, deleteDomainAction } from "./actions";

interface DomainData {
  id: string;
  name: string;
  slug: string;
  description: string;
  isSystem: boolean;
  entityCount: number;
  deletionImpact: DomainDeletionImpact;
  createdAt: Date;
}

interface DomainGridProps {
  domains: DomainData[];
  canDeleteDomains?: boolean;
}

export function DomainGrid({ domains, canDeleteDomains = false }: DomainGridProps) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DomainData | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

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
      invalidateDomainsTree();
      setShowCreate(false);
    }
  }

  function openDeleteConfirm(domain: DomainData) {
    setDeleteTarget(domain);
    setDeleteError(null);
  }

  async function handleDeleteDomain() {
    if (!deleteTarget) return;

    setDeleteError(null);
    setIsDeleting(true);
    try {
      const result = await deleteDomainAction(deleteTarget.id);

      if (result.error) {
        setDeleteError(result.error);
        return;
      }

      void invalidateDomainsTree();
      setDeleteTarget(null);
      router.refresh();
    } catch {
      setDeleteError("Unable to delete the domain. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div className="animate-auth-fade-up">
      {deleteTarget ? (
        <DomainDeletionDialog
          open
          domainName={deleteTarget.name}
          impact={deleteTarget.deletionImpact}
          isDeleting={isDeleting}
          error={deleteError}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
          onConfirm={handleDeleteDomain}
        />
      ) : null}

      {/* Header */}
      <div className="flex items-center justify-between mb-space-6">
        <div>
          <h1 className="text-display text-foreground">Domains</h1>
          <p className="text-body text-muted-foreground mt-space-1">
            Select a domain to manage its logical entities
          </p>
        </div>
        <div className="flex items-center gap-space-2">
          <Link
            href="/schemas/type-mappings"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Sparkles className="w-4 h-4" />
            Type Mapping Reference
          </Link>
          <Button
            onClick={() => setShowCreate(true)}
            className="gap-2"
            data-testid="create-domain-button"
          >
            <Plus className="w-4 h-4" />
            Create Domain
          </Button>
        </div>
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
        <div className="surface-glass rounded-xl border border-primary/20 p-space-6 mb-space-6" data-testid="create-domain-form">
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
                data-testid="domain-name-input"
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
                data-testid="domain-description-input"
              />
            </div>
            {createError && (
              <p className="text-body-small text-destructive" data-testid="create-domain-error">{createError}</p>
            )}
            <div className="flex gap-space-2">
              <Button type="submit" disabled={isCreating} data-testid="create-domain-submit">
                {isCreating ? "Creating..." : "Create"}
              </Button>
              <Button
                type="button"
                variant="outline"
                data-testid="create-domain-cancel"
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
        search ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-heading-2 text-foreground mb-space-2">
              No domains found
            </p>
            <p className="text-body text-muted-foreground">
              Try a different search term
            </p>
          </div>
        ) : domains.filter((d) => !d.isSystem).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Database className="w-16 h-16 text-muted-foreground/30 mb-space-4" />
            <h2 className="text-heading-1 text-foreground mb-space-2">
              Welcome to Super Schema
            </h2>
            <p className="text-body text-muted-foreground mb-space-2 max-w-md">
              Super Schema helps you define, govern, and emit logical schemas across your data platform. Start by creating your first domain.
            </p>
            <p className="text-body-small text-muted-foreground mb-space-6 max-w-md">
              A domain groups related entities together &mdash; for example, &ldquo;Customer&rdquo;, &ldquo;Payment&rdquo;, or &ldquo;Inventory&rdquo;.
            </p>
            <div className="flex items-center gap-space-3">
              <Button onClick={() => setShowCreate(true)} className="gap-2" size="lg">
                <Plus className="w-4 h-4" />
                Create Your First Domain
              </Button>
            </div>
            <div className="mt-space-8 grid grid-cols-1 sm:grid-cols-3 gap-space-4 max-w-2xl w-full text-left">
              <div className="rounded-lg border border-border/50 p-space-4">
                <div className="text-primary font-mono text-caption font-medium mb-space-1">Step 1</div>
                <p className="text-body-small text-foreground font-medium">Create a Domain</p>
                <p className="text-caption text-muted-foreground mt-1">Group related entities under a business domain.</p>
              </div>
              <div className="rounded-lg border border-border/50 p-space-4">
                <div className="text-primary font-mono text-caption font-medium mb-space-1">Step 2</div>
                <p className="text-body-small text-foreground font-medium">Define Entities</p>
                <p className="text-caption text-muted-foreground mt-1">Add logical entities with fields, types, and classifications.</p>
              </div>
              <div className="rounded-lg border border-border/50 p-space-4">
                <div className="text-primary font-mono text-caption font-medium mb-space-1">Step 3</div>
                <p className="text-body-small text-foreground font-medium">Emit Schemas</p>
                <p className="text-caption text-muted-foreground mt-1">Generate BigQuery, Avro, OpenAPI and more with one click.</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-heading-2 text-foreground mb-space-2">
              No domains found
            </p>
            <p className="text-body text-muted-foreground">
              Create your first domain to get started
            </p>
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
          {filtered.map((domain) => (
            <DomainCard
              key={domain.id}
              {...domain}
              canDeleteDomain={canDeleteDomains}
              onRequestDelete={() => openDeleteConfirm(domain)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
