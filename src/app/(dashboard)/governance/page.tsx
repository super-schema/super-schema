"use client";

import { useState, useCallback, useEffect } from "react";
import { GovernanceDashboard } from "@/features/governance/GovernanceDashboard";
import type { GovernanceRequest } from "@/types/schemas/governance";
import {
  getGovernanceRequestsAction,
  approveGovernanceRequestAction,
  rejectGovernanceRequestAction,
} from "./actions";

export default function GovernancePage() {
  const [requests, setRequests] = useState<GovernanceRequest[]>([]);

  const loadRequests = useCallback(async () => {
    const result = await getGovernanceRequestsAction();
    if ("data" in result && result.data) {
      setRequests(result.data);
    }
  }, []);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  const handleApprove = useCallback(
    async (requestId: string, comment: string | null) => {
      const result = await approveGovernanceRequestAction(requestId, comment);
      if ("success" in result) {
        loadRequests();
      }
    },
    [loadRequests]
  );

  const handleReject = useCallback(
    async (requestId: string, comment: string | null) => {
      const result = await rejectGovernanceRequestAction(requestId, comment);
      if ("success" in result) {
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
