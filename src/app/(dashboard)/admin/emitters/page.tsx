"use client";

import { EmitterCardGrid } from "@/components/custom/admin/EmitterCardGrid";

/**
 * Admin Panel — Emitters tab.
 * Enable/disable emitters and manage type mapping policies.
 */
export default function AdminEmittersPage() {
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-3 text-foreground">Emitters</h2>
          <p className="text-body-small text-muted-foreground">
            Enable or disable emitter targets and configure type mapping policies.
          </p>
        </div>
      </div>
      <EmitterCardGrid />
    </div>
  );
}
