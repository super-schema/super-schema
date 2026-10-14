"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Database,
  Clock,
  Zap,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getRecentEntityEntries,
  trackRecentEntity,
  type RecentEntityEntry,
} from "@/lib/recent-entities";
import { assetHref } from "@/lib/navigation/asset-href";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";
import type {
  CommandPaletteProps,
  CommandPaletteEntity,
  CommandPaletteField,
} from "./CommandPalette.types";

const ENTERPRISE_LABEL = "Enterprise";

/**
 * Flatten the explorer tree into palette entries: tenant-level (enterprise)
 * entities first, then every product's entities. Tenant-level entities carry
 * `domainSlug`/`productSlug` of null so `assetHref` resolves their canonical URL.
 */
function flattenExplorerEntities(tree: ExplorerTree): CommandPaletteEntity[] {
  const list: CommandPaletteEntity[] = tree.enterprise.entities.map((entity) => ({
    id: entity.id,
    name: entity.name,
    slug: entity.slug,
    domainName: ENTERPRISE_LABEL,
    domainSlug: null,
    productSlug: null,
    status: entity.status,
  }));
  for (const domain of tree.domains) {
    for (const product of domain.products) {
      for (const entity of product.entities) {
        list.push({
          id: entity.id,
          name: entity.name,
          slug: entity.slug,
          domainName: domain.name,
          domainSlug: domain.slug,
          productSlug: product.slug,
          status: entity.status,
        });
      }
    }
  }
  return list;
}

export function CommandPalette({
  isOpen,
  onClose,
  actions: externalActions,
}: Omit<CommandPaletteProps, "entities" | "fields"> & {
  actions?: CommandPaletteProps["actions"];
}) {
  const router = useRouter();
  const [entities, setEntities] = useState<CommandPaletteEntity[]>([]);
  const [fields, setFields] = useState<CommandPaletteField[]>([]);
  const [recentEntries, setRecentEntries] = useState<RecentEntityEntry[]>([]);

  // Fetch entity & field data when palette opens
  useEffect(() => {
    if (!isOpen) return;

    const recentTimer = window.setTimeout(() => {
      setRecentEntries(getRecentEntityEntries());
    }, 0);

    // Fetch domains tree for entities
    async function fetchData() {
      try {
        const res = await fetch("/api/domains-tree");
        if (!res.ok) return;
        const tree: ExplorerTree = await res.json();
        setEntities(flattenExplorerEntities(tree));

        // Fetch fields for command palette
        try {
          const fieldsRes = await fetch("/api/command-palette-fields");
          if (fieldsRes.ok) {
            const fieldsData = await fieldsRes.json();
            setFields(fieldsData);
          }
        } catch {
          // Fields API may not exist yet — that's fine
        }
      } catch {
        // Silently fail
      }
    }
    fetchData();

    return () => window.clearTimeout(recentTimer);
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, onClose]);

  const navigateToEntity = useCallback(
    (entity: CommandPaletteEntity) => {
      trackRecentEntity({
        entityId: entity.id,
        domainSlug: entity.domainSlug,
        entityName: entity.name,
        domainName: entity.domainName,
      });
      router.push(
        assetHref({
          kind: "entity",
          slug: entity.slug || entity.id,
          domainSlug: entity.domainSlug,
          productSlug: entity.productSlug ?? null,
        })
      );
      onClose();
    },
    [router, onClose]
  );

  const navigateToField = useCallback(
    (field: CommandPaletteField) => {
      router.push(
        field.productSlug
          ? `/schemas/${field.domainSlug}/${field.productSlug}/${field.entitySlug || field.entityId}/fields/${field.slug || field.id}`
          : `/schemas/${field.domainSlug}/${field.entitySlug || field.entityId}/fields/${field.slug || field.id}`
      );
      onClose();
    },
    [router, onClose]
  );

  // Build recent entities from entries + fetched entities
  const recentEntities = useMemo(() => {
    return recentEntries
      .map((entry) => {
        const found = entities.find((e) => e.id === entry.entityId);
        if (found) return found;
        // Use stored data as fallback
        return {
          id: entry.entityId,
          name: entry.entityName,
          domainName: entry.domainName,
          domainSlug: entry.domainSlug,
        };
      })
      .filter((e) => e.name); // filter out entries with no name
  }, [recentEntries, entities]);

  // Default actions
  const defaultActions = useMemo(
    () => [
      ...(externalActions || []),
    ],
    [externalActions]
  );

  function getStatusColor(status?: string) {
    switch (status) {
      case "ACTIVE":
        return "bg-success";
      case "DRAFT":
        return "bg-warning";
      default:
        return "bg-muted-foreground";
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* Backdrop overlay */}
      <div
        className="absolute inset-0 bg-[rgba(0,0,0,0.6)] backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Command dialog */}
      <div
        className="relative w-full max-w-[640px] bg-[rgba(28,28,38,0.8)] backdrop-blur-[12px] rounded-[12px] border border-border overflow-hidden"
        style={{ boxShadow: "0 4px 12px rgba(0,0,0,0.4)", maxHeight: 400 }}
      >
        <Command className="bg-transparent" loop>
          <CommandInput
            placeholder="Search entities, fields, actions..."
            className="h-12 text-body border-b border-border"
          />
          <CommandList className="max-h-[340px] overflow-y-auto">
            <CommandEmpty className="py-6 text-center text-body-small text-muted-foreground">
              No results found.
            </CommandEmpty>

            {/* Recent section */}
            {recentEntities.length > 0 && (
              <CommandGroup heading="Recent">
                {recentEntities.map((entity) => (
                  <CommandItem
                    key={`recent-${entity.id}`}
                    value={`recent ${entity.name} ${entity.domainName}`}
                    onSelect={() => navigateToEntity(entity)}
                    className="gap-2 cursor-pointer"
                  >
                    <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-mono text-body-small">{entity.name}</span>
                    <span className="text-caption text-muted-foreground ml-auto">
                      {entity.domainName}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Entities section */}
            {entities.length > 0 && (
              <CommandGroup heading="Entities">
                {entities.map((entity) => (
                  <CommandItem
                    key={`entity-${entity.id}`}
                    value={`entity ${entity.name} ${entity.domainName}`}
                    onSelect={() => navigateToEntity(entity)}
                    className="gap-2 cursor-pointer"
                  >
                    <Database className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-mono text-body-small">{entity.name}</span>
                    <div className="flex items-center gap-1.5 ml-auto">
                      {entity.status && (
                        <span
                          className={`w-2 h-2 rounded-full ${getStatusColor(entity.status)}`}
                        />
                      )}
                      <span className="text-caption text-muted-foreground">
                        {entity.domainName}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Fields section */}
            {fields.length > 0 && (
              <CommandGroup heading="Fields">
                {fields.map((field) => (
                  <CommandItem
                    key={`field-${field.id}`}
                    value={`field ${field.entityName} ${field.name} ${field.type}`}
                    onSelect={() => navigateToField(field)}
                    className="gap-2 cursor-pointer"
                  >
                    <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-mono text-body-small">
                      {field.entityName}
                      <span className="text-muted-foreground mx-1">&rarr;</span>
                      {field.name}
                    </span>
                    <Badge
                      variant="secondary"
                      className="text-[10px] h-4 px-1 font-mono ml-auto"
                    >
                      {field.type}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Actions section */}
            <CommandGroup heading="Actions">
              {defaultActions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={`action ${action.label}`}
                  onSelect={() => {
                    if (!action.disabled) {
                      action.onSelect();
                      onClose();
                    }
                  }}
                  disabled={action.disabled}
                  className="gap-2 cursor-pointer"
                >
                  {action.icon}
                  <span>{action.label}</span>
                  {action.shortcut && (
                    <CommandShortcut>{action.shortcut}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
              <CommandItem
                value="action go to domains"
                onSelect={() => {
                  router.push("/schemas");
                  onClose();
                }}
                className="gap-2 cursor-pointer"
              >
                <Zap className="w-4 h-4 text-muted-foreground" />
                Go to Domains
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    </div>
  );
}
