"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/admin/tenant", label: "Domains" },
  { href: "/admin/tenant/storage", label: "Storage & onboarding" },
  { href: "/admin/tenant/dictionaries", label: "Dictionaries" },
  { href: "/admin/tenant/attributes", label: "Custom attributes" },
] as const;

export function TenantShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-w-0 flex-col gap-space-4">
      <header className="flex flex-col gap-space-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-heading-3 text-foreground">Tenant</h2>
          <p className="text-body-small text-muted-foreground">
            Manage domains, storage, dictionaries, and custom attributes for the active tenant.
          </p>
        </div>
        <nav aria-label="Tenant configuration" className="flex flex-wrap gap-space-1 border-b border-border pb-space-2">
          {SECTIONS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined}
                className={cn("rounded-md px-space-3 py-space-2 text-body-small transition-colors focus-visible:outline-2 focus-visible:outline-ring", active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
                {label}
              </Link>
            );
          })}
        </nav>
      </header>
      {children}
    </div>
  );
}
