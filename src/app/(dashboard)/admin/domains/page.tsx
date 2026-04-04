"use client";

import { DomainDataTable } from "@/components/custom/admin/DomainDataTable";

/**
 * Admin Panel — Domains tab.
 * Manage domain workspaces and policy templates.
 */
export default function AdminDomainsPage() {
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-3 text-foreground">Domains</h2>
          <p className="text-body-small text-muted-foreground">
            Manage domain workspaces and configure policy templates.
          </p>
        </div>
      </div>
      <DomainDataTable />
    </div>
  );
}
