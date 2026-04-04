"use client";

import { ClassificationList } from "@/components/custom/admin/ClassificationList";

/**
 * Admin Panel — Classifications tab.
 * Manage custom classification taxonomy levels.
 */
export default function AdminClassificationsPage() {
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-heading-3 text-foreground">Classifications</h2>
          <p className="text-body-small text-muted-foreground">
            Define custom classification levels beyond system defaults.
          </p>
        </div>
      </div>
      <ClassificationList />
    </div>
  );
}
