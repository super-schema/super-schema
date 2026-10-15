"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package, Plus, Search, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { formatDateOnly } from "@/lib/date-format";
import { assetHref } from "@/lib/navigation/asset-href";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { NO_EVENTS_ASSETS, productDeleteBlocker, type EventsAssetCounts } from "@/lib/product-deletion";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import {
  createProductAction,
  deleteProductAction,
} from "./product-actions";

export interface ProductGridItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  ownerTeam: string | null;
  isSystem: boolean;
  entityCount: number;
  /** Product-level Data Types (enums + scalars + unions) — cascade with the product. */
  dataTypeCount: number;
  /** Product-level APIs (service definitions) — cascade with the product. */
  apiCount: number;
  /** Events assets (channels, messages, traits, event specs) — cascade with the product; absent = none known. */
  eventsAssets?: EventsAssetCounts;
  updatedAt: Date | string;
  tier: {
    id: string;
    name: string;
    displayColor: string;
    bgColor: string;
    textColor: string;
  } | null;
}

export interface TierOption {
  id: string;
  name: string;
  bgColor: string;
  textColor: string;
}

interface ProductGridProps {
  domainId: string;
  domainName: string;
  domainSlug: string;
  products: ProductGridItem[];
  tiers: TierOption[];
}

/** Same rule as the server guard: anything that would cascade blocks the delete. */
function deleteBlocker(product: ProductGridItem): string | null {
  return productDeleteBlocker({
    entities: product.entityCount,
    sharedEnums: product.dataTypeCount,
    customScalars: 0,
    unionTypes: 0,
    services: product.apiCount,
    ...(product.eventsAssets ?? NO_EVENTS_ASSETS),
  });
}

function tierLabel(name: string) {
  return name.replace(/_/g, " ");
}

export function ProductGrid({
  domainId,
  domainName,
  domainSlug,
  products,
  tiers,
}: ProductGridProps) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tierId, setTierId] = useState<string>("");
  const [ownerTeam, setOwnerTeam] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.ownerTeam ?? "").toLowerCase().includes(q)
    );
  }, [products, search]);

  function resetCreate() {
    setShowCreate(false);
    setName("");
    setDescription("");
    setTierId("");
    setOwnerTeam("");
    setCreateError(null);
  }

  async function handleCreate() {
    if (!name.trim()) {
      setCreateError("Product name is required");
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    try {
      const result = await createProductAction({
        domainId,
        name: name.trim(),
        description,
        tierId: tierId || null,
        ownerTeam: ownerTeam.trim() || null,
      });
      if (result.error) {
        setCreateError(result.error);
        return;
      }
      invalidateDomainsTree();
      resetCreate();
      if (result.slug) {
        router.push(assetHref({ kind: "product", domainSlug, productSlug: result.slug }));
      } else {
        router.refresh();
      }
    } catch (e: unknown) {
      // A rejected action (network, serialization, an unwrapped server throw) must not leave the form stuck on "Creating…".
      console.error("[product-grid] create product failed", e);
      setCreateError(GENERIC_ACTION_ERROR);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete(product: ProductGridItem) {
    const blocker = deleteBlocker(product);
    if (blocker) {
      toast.error(blocker);
      return;
    }
    try {
      const result = await deleteProductAction(product.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`"${product.name}" deleted`);
      void invalidateDomainsTree();
      router.refresh();
    } catch (e: unknown) {
      console.error("[product-grid] delete product failed", e);
      toast.error(GENERIC_ACTION_ERROR);
    }
  }

  return (
    <div>
      {/* Toolbar (the domain header lives above the tabs in DomainTabs) */}
      <div className="flex items-center justify-between gap-space-4 mb-space-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          New Product
        </Button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="surface-glass rounded-xl border border-primary/20 p-space-6 mb-space-6">
          <h3 className="text-heading-2 text-foreground mb-space-4">
            Create New Product
          </h3>
          <div className="space-y-space-4">
            <div>
              <label className="text-body-small text-foreground mb-space-1 block font-medium">
                Name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., OneSCM, Bank"
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
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this product"
                className="h-9"
              />
            </div>
            <div className="flex gap-space-4 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <label className="text-body-small text-foreground mb-space-1 block font-medium">
                  Criticality Tier
                </label>
                <select
                  value={tierId}
                  onChange={(e) => setTierId(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-3 text-body-small text-foreground"
                >
                  <option value="">None</option>
                  {tiers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {tierLabel(t.name)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="text-body-small text-foreground mb-space-1 block font-medium">
                  Owner Team
                </label>
                <Input
                  value={ownerTeam}
                  onChange={(e) => setOwnerTeam(e.target.value)}
                  placeholder="e.g., Payments Platform"
                  className="h-9"
                />
              </div>
            </div>
            {createError && (
              <p className="text-body-small text-destructive">{createError}</p>
            )}
            <div className="flex gap-space-2">
              <Button onClick={handleCreate} disabled={isCreating}>
                {isCreating ? "Creating..." : "Create"}
              </Button>
              <Button type="button" variant="outline" onClick={resetCreate}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Package className="w-16 h-16 text-muted-foreground/30 mb-space-4" />
          <h2 className="text-heading-1 text-foreground mb-space-2">
            {search ? "No products found" : "Create your first product"}
          </h2>
          <p className="text-body text-muted-foreground mb-space-6 max-w-md">
            {search
              ? "Try a different search term"
              : `Products group schemas under ${domainName} and carry their own criticality tier. Create one to start defining entities.`}
          </p>
          {!search && (
            <Button onClick={() => setShowCreate(true)} className="gap-2" size="lg">
              <Plus className="w-4 h-4" />
              New Product
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-space-4">
          {filtered.map((product) => {
            const blocker = deleteBlocker(product);
            const canDelete = !product.isSystem && blocker === null;
            return (
              <div
                key={product.id}
                className="group relative surface-glass rounded-xl border border-border p-space-6 transition-all duration-200 hover:border-primary/40 hover:shadow-lg"
              >
                <Link
                  href={assetHref({ kind: "product", domainSlug, productSlug: product.slug })}
                  className="block"
                >
                  <div className="flex items-center gap-space-2 mb-space-2 pr-9">
                    <Package className="w-5 h-5 text-primary shrink-0" />
                    <h3 className="text-heading-2 text-foreground group-hover:text-primary transition-colors truncate">
                      {product.name}
                    </h3>
                  </div>

                  <div className="flex items-center gap-space-2 justify-end mb-space-3 flex-wrap">
                    {product.tier && (
                      <span
                        className="text-caption px-1.5 py-0.5 rounded font-medium"
                        style={{
                          backgroundColor: product.tier.bgColor,
                          color: product.tier.textColor,
                        }}
                      >
                        {tierLabel(product.tier.name)}
                      </span>
                    )}
                    {product.isSystem && (
                      <Badge variant="outline" className="text-caption">
                        System
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-caption">
                      {product.entityCount}{" "}
                      {product.entityCount === 1 ? "entity" : "entities"}
                    </Badge>
                  </div>

                  <p className="text-body-small text-muted-foreground line-clamp-2 mb-space-3">
                    {product.description || "No description"}
                  </p>

                  <div className="flex items-center gap-space-3 text-caption text-muted-foreground">
                    {product.ownerTeam && (
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {product.ownerTeam}
                      </span>
                    )}
                    <span className="ml-auto">
                      {formatDateOnly(new Date(product.updatedAt))}
                    </span>
                  </div>
                </Link>

                {!product.isSystem && (
                  <button
                    type="button"
                    onClick={() => handleDelete(product)}
                    disabled={!canDelete}
                    aria-label={`Delete product ${product.name}`}
                    title={canDelete ? `Delete ${product.name}` : (blocker ?? undefined)}
                    className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
