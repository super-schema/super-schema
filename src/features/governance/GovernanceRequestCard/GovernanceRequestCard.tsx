"use client";

/**
 * GovernanceRequestCard
 *
 * Displays a governance request with entity name, change summary,
 * severity badge, requestor info, and approve/reject actions.
 */

import { useState } from "react";
import type { GovernanceRequest } from "@/types/schemas/governance";

interface GovernanceRequestCardProps {
  request: GovernanceRequest;
  onApprove?: (requestId: string, comment: string | null) => void;
  onReject?: (requestId: string, comment: string | null) => void;
  showActions?: boolean;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "bg-amber-500/20", text: "text-amber-400" },
  APPROVED: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  REJECTED: { bg: "bg-red-500/20", text: "text-red-400" },
  AUTO_APPROVED: { bg: "bg-emerald-500/20", text: "text-emerald-300" },
};

const SEVERITY_STYLES: Record<string, { bg: string; text: string }> = {
  low: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  medium: { bg: "bg-amber-500/20", text: "text-amber-400" },
  high: { bg: "bg-red-500/20", text: "text-red-400" },
  critical: { bg: "bg-red-600/30", text: "text-red-300" },
};

function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function GovernanceRequestCard({
  request,
  onApprove,
  onReject,
  showActions = true,
}: GovernanceRequestCardProps) {
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(
    null
  );

  const statusStyle = STATUS_STYLES[request.status] ?? STATUS_STYLES.PENDING;
  const severity = request.impactReport?.changeClassification?.severity ?? "low";
  const sevStyle = SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low;

  const handleAction = (type: "approve" | "reject") => {
    if (!showComment) {
      setActionType(type);
      setShowComment(true);
      return;
    }

    if (type === "approve" && onApprove) {
      onApprove(request.id, comment || null);
    } else if (type === "reject" && onReject) {
      onReject(request.id, comment || null);
    }
    setShowComment(false);
    setComment("");
    setActionType(null);
  };

  return (
    <div
      data-testid="governance-request-card"
      className="rounded-lg border border-border p-4"
      style={{
        background: "rgba(28, 28, 38, 0.8)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <h3 className="text-body font-semibold text-foreground">
            {request.entityName ?? request.entityId}
          </h3>
          <p className="text-caption text-muted-foreground mt-0.5">
            {request.impactReport?.summary ?? `${request.changeType} change`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${sevStyle.bg} ${sevStyle.text}`}
          >
            {severity}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${statusStyle.bg} ${statusStyle.text}`}
          >
            {request.status}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-mono-small text-muted-foreground mb-3">
        <span>Requested by: {request.requestedBy}</span>
        <span title={request.createdAt}>
          {relativeTime(request.createdAt)}
        </span>
        <span>v{request.versionId}</span>
      </div>

      {showActions && request.status === "PENDING" && (
        <div className="space-y-2">
          {showComment && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder={`Optional comment for ${actionType}...`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="flex-1 px-3 py-1.5 rounded border border-border bg-transparent text-caption text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleAction("approve")}
              className="px-4 py-1.5 rounded text-caption font-medium text-white transition-colors"
              style={{
                background:
                  actionType === "approve"
                    ? "#8B5CF6"
                    : "linear-gradient(135deg, #A477B2, #8B5CF6)",
              }}
            >
              {actionType === "approve" && showComment
                ? "Confirm Approve"
                : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => handleAction("reject")}
              className={`px-4 py-1.5 rounded text-caption font-medium transition-colors ${
                actionType === "reject" && showComment
                  ? "bg-red-600 text-white"
                  : "border border-red-500/50 text-red-400 hover:bg-red-500/10"
              }`}
            >
              {actionType === "reject" && showComment
                ? "Confirm Reject"
                : "Reject"}
            </button>
            {showComment && (
              <button
                type="button"
                onClick={() => {
                  setShowComment(false);
                  setActionType(null);
                  setComment("");
                }}
                className="px-3 py-1.5 rounded text-caption text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
