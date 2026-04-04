"use client";

/**
 * GovernanceDashboard
 *
 * Split layout: request list (left) + detail panel (right).
 * Shows pending, domain, and history sections.
 */

import { useState } from "react";
import type { GovernanceRequest } from "@/types/schemas/governance";
import { GovernanceRequestCard } from "../GovernanceRequestCard";
import { ImpactReportCard } from "../ImpactReportCard";

interface GovernanceDashboardProps {
  requests: GovernanceRequest[];
  onApprove?: (requestId: string, comment: string | null) => void;
  onReject?: (requestId: string, comment: string | null) => void;
}

type Tab = "pending" | "all" | "history";

export function GovernanceDashboard({
  requests,
  onApprove,
  onReject,
}: GovernanceDashboardProps) {
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(
    null
  );
  const [activeTab, setActiveTab] = useState<Tab>("pending");

  const pendingRequests = requests.filter((r) => r.status === "PENDING");
  const historyRequests = requests.filter(
    (r) => r.status === "APPROVED" || r.status === "REJECTED"
  );

  const filteredRequests =
    activeTab === "pending"
      ? pendingRequests
      : activeTab === "history"
        ? historyRequests
        : requests;

  const selectedRequest = selectedRequestId
    ? requests.find((r) => r.id === selectedRequestId)
    : null;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "pending", label: "Pending", count: pendingRequests.length },
    { key: "all", label: "All Requests", count: requests.length },
    { key: "history", label: "History", count: historyRequests.length },
  ];

  return (
    <div
      data-testid="governance-dashboard"
      className="flex h-full"
    >
      {/* Left panel: request list */}
      <div className="w-1/2 border-r border-border overflow-y-auto p-4 space-y-4">
        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border pb-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-t text-caption font-medium transition-colors ${
                activeTab === tab.key
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-mono-small bg-muted">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Request list */}
        {filteredRequests.length === 0 ? (
          <div className="text-center py-8 text-caption text-muted-foreground">
            No {activeTab === "pending" ? "pending" : ""} requests
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRequests.map((request) => (
              <div
                key={request.id}
                onClick={() => setSelectedRequestId(request.id)}
                className={`cursor-pointer rounded-lg transition-colors ${
                  selectedRequestId === request.id
                    ? "ring-1 ring-primary"
                    : "hover:ring-1 hover:ring-border"
                }`}
              >
                <GovernanceRequestCard
                  request={request}
                  onApprove={onApprove}
                  onReject={onReject}
                  showActions={request.status === "PENDING"}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right panel: detail/impact report */}
      <div className="w-1/2 overflow-y-auto p-4">
        {selectedRequest ? (
          <div className="space-y-4">
            <h2 className="text-heading-2 text-foreground">
              {selectedRequest.entityName ?? selectedRequest.entityId}
            </h2>
            <div className="text-caption text-muted-foreground">
              Version {selectedRequest.versionId} - {selectedRequest.changeType}{" "}
              change
            </div>

            {selectedRequest.impactReport && (
              <ImpactReportCard report={selectedRequest.impactReport} />
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-caption text-muted-foreground">
            Select a request to view details
          </div>
        )}
      </div>
    </div>
  );
}
