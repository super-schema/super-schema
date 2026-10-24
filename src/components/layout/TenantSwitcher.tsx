"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { setActiveTenantAction } from "@/app/(dashboard)/schemas/tenant-actions";

interface TenantOption {
  id: string;
  name: string;
  slug: string;
  description: string;
  isSystem: boolean;
  domainCount: number;
}

export function TenantSwitcher() {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/tenants");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setTenants(data.tenants ?? []);
        setActiveTenantId(data.activeTenantId ?? null);
      } catch {
        // Soft label — fail silently, switcher just won't render options.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const active = tenants.find((t) => t.id === activeTenantId) ?? tenants[0];

  // Nothing to switch between — hide the control entirely.
  if (tenants.length <= 1 && !active) {
    return null;
  }

  function handleSelect(tenantId: string) {
    if (tenantId === activeTenantId) return;
    setActiveTenantId(tenantId);
    startTransition(async () => {
      const result = await setActiveTenantAction(tenantId);
      if (result?.error) {
        // Revert optimistic selection on failure.
        setActiveTenantId(activeTenantId);
        return;
      }
      invalidateDomainsTree();
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="tenant-switcher"
        disabled={isPending}
        className="flex items-center gap-space-2 rounded-lg border border-border bg-muted/50 px-space-2 py-1 text-left transition-colors hover:border-primary/40 hover:bg-accent/30 outline-none disabled:opacity-60"
        title="Switch organization"
      >
        <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-body-small text-foreground max-w-[140px] truncate">
          {active?.name ?? "Organization"}
        </span>
        <ChevronsUpDown className="w-3 h-3 text-muted-foreground shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tenants.map((tenant) => {
          const isActive = tenant.id === active?.id;
          return (
            <DropdownMenuItem
              key={tenant.id}
              data-testid="tenant-option"
              data-tenant-id={tenant.id}
              data-active={isActive ? "true" : "false"}
              onClick={() => handleSelect(tenant.id)}
              className="flex items-center gap-space-2"
            >
              <Check
                className={cn(
                  "w-4 h-4 shrink-0",
                  isActive ? "opacity-100 text-primary" : "opacity-0"
                )}
              />
              <span className="flex-1 truncate">{tenant.name}</span>
              <span className="text-caption text-muted-foreground" data-testid="tenant-option-domain-count">
                {tenant.domainCount}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
