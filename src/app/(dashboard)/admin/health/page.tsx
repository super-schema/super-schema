"use client";

import { HealthDashboard } from "@/components/custom/admin/HealthDashboard";

/**
 * Admin Panel — Health tab.
 * Monitor system health, usage metrics, and errors.
 */
export default function AdminHealthPage() {
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-3 text-foreground">System Health</h2>
          <p className="text-body-small text-muted-foreground">
            Monitor system health, usage metrics, and error summaries.
          </p>
        </div>
      </div>
      <HealthDashboard />
    </div>
  );
}
