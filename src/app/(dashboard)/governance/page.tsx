"use client";

/**
 * Governance Dashboard Page
 *
 * Accessible from Activity Bar. Shows pending requests, all requests,
 * and history. Supports approve/reject actions.
 */

import { useState, useCallback, useEffect } from "react";
import { GovernanceDashboard } from "@/features/governance/GovernanceDashboard";
import type { GovernanceRequest } from "@/types/schemas/governance";
import {
  getAllRequests,
  approveRequest,
  rejectRequest,
} from "@/services/governance.service";

export default function GovernancePage() {
  const [requests, setRequests] = useState<GovernanceRequest[]>([]);

  const loadRequests = useCallback(async () => {
    const result = await getAllRequests();
    if (result.success) {
      setRequests(result.data);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleApprove = useCallback(
    async (requestId: string, comment: string | null) => {
      const result = await approveRequest(requestId, comment, {
        userId: "current-user",
        userRole: "STEWARD",
      });
      if (result.success) {
        loadRequests();
      }
    },
    [loadRequests]
  );

  const handleReject = useCallback(
    async (requestId: string, comment: string | null) => {
      const result = await rejectRequest(requestId, comment, {
        userId: "current-user",
        userRole: "STEWARD",
      });
      if (result.success) {
        loadRequests();
      }
    },
    [loadRequests]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-heading-1 text-foreground">
          Governance Dashboard
        </h1>
        <p className="text-caption text-muted-foreground mt-1">
          Review and approve schema change requests
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <GovernanceDashboard
          requests={requests}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      </div>
    </div>
  );
}
