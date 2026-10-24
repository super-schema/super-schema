"use client";

import type React from "react";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { ChevronRight, Check, Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DeprecationBanner, type ReplacementEntityLink } from "@/components/custom/DeprecationBanner";
import { RetirementBanner } from "@/components/custom/RetirementBanner";
import { assetHref } from "@/lib/navigation/asset-href";
import { levelLabel } from "@/lib/levels";
import { describeDraftState, type DraftVersionState } from "@/lib/entity-versioning/draft-label";

type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";

const STATUS_OPTIONS: { value: EntityStatus; label: string; color: string; dotColor: string }[] = [
  { value: "DRAFT", label: "DRAFT", color: "#e5a93b", dotColor: "bg-warning" },
  { value: "ACTIVE", label: "ACTIVE", color: "#5bc27a", dotColor: "bg-success" },
  { value: "DEPRECATED", label: "DEPRECATED", color: "#e88a3b", dotColor: "bg-[#e88a3b]" },
  { value: "RETIRED", label: "RETIRED", color: "#8a8694", dotColor: "bg-muted-foreground" },
];

function getStatusOption(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];
}

interface EntityHeaderProps {
  /** TENANT entities get an "Enterprise › <Entity>" breadcrumb. */
  level: "TENANT" | "PRODUCT";
  entity: {
    id: string;
    name: string;
    description: string;
    status: string;
    version: number;
    domainName: string;
    /** null for tenant-level entities. */
    domainSlug: string | null;
    /** null for tenant-level entities. */
    productSlug: string | null;
    productName: string | null;
    metadata: Record<string, unknown> | null;
  };
  onStatusChange: (newStatus: EntityStatus, metadata?: Record<string, unknown>) => void;
  readOnly: boolean;
  isPending: boolean;
  statusError: string | null;
  toolbar?: React.ReactNode;
  showSaved?: boolean;
  /** Draft + Publish state (spec §5.3). */
  versionState: DraftVersionState;
  /** Opens the publish dialog; omit for read-only entities. */
  onPublish?: () => void;
  /** The deprecation replacement, resolved server-side (null = named but not found). */
  replacementEntity?: ReplacementEntityLink | null;
}

export function EntityHeader({
  level,
  entity,
  onStatusChange,
  readOnly,
  isPending,
  statusError,
  toolbar,
  showSaved = false,
  versionState,
  onPublish,
  replacementEntity,
}: EntityHeaderProps) {
  const currentStatus = getStatusOption(entity.status);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Deprecation form state
  const [showDeprecationForm, setShowDeprecationForm] = useState(false);
  const [depSince, setDepSince] = useState(new Date().toISOString().split("T")[0]);
  const [depReplacementEntityId, setDepReplacementEntityId] = useState("");
  const [depMigrationNotes, setDepMigrationNotes] = useState("");

  // Close status dropdown on click outside or Escape
  useEffect(() => {
    if (!statusDropdownOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setStatusDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [statusDropdownOpen]);

  function handleStatusSelect(newStatus: EntityStatus) {
    setStatusDropdownOpen(false);
    if (newStatus === entity.status) return;

    if (newStatus === "DEPRECATED") {
      setShowDeprecationForm(true);
      return;
    }

    onStatusChange(newStatus);
  }

  function handleDeprecationSubmit() {
    const existingMeta = (entity.metadata || {}) as Record<string, unknown>;
    const metadata = {
      ...existingMeta,
      deprecation: {
        deprecated: true,
        since: depSince,
        replacementEntityId: depReplacementEntityId || null,
        migrationNotes: depMigrationNotes || undefined,
      },
    };
    onStatusChange("DEPRECATED", metadata);
    setShowDeprecationForm(false);
  }

  return (
    <>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        {level === "TENANT" || !entity.domainSlug ? (
          <Link
            href={assetHref({ kind: "enterprise" })}
            className="hover:text-foreground transition-colors"
          >
            {levelLabel("TENANT")}
          </Link>
        ) : (
          <>
            <Link href="/schemas" className="hover:text-foreground transition-colors">
              Domains
            </Link>
            <ChevronRight className="w-3 h-3" />
            <Link
              href={assetHref({ kind: "domain", domainSlug: entity.domainSlug })}
              className="hover:text-foreground transition-colors"
            >
              {entity.domainName}
            </Link>
            {entity.productSlug && entity.productName !== null && (
              <>
                <ChevronRight className="w-3 h-3" />
                <Link
                  href={assetHref({
                    kind: "product",
                    domainSlug: entity.domainSlug,
                    productSlug: entity.productSlug,
                  })}
                  className="hover:text-foreground transition-colors"
                >
                  {entity.productName}
                </Link>
              </>
            )}
          </>
        )}
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium font-mono">{entity.name}</span>
      </nav>

      {/* Header row (name + status + version + toolbar) */}
      <div className="flex items-center justify-between mb-space-4">
        <div className="flex items-center gap-space-3">
        <h1 className="text-display text-foreground font-mono">{entity.name}</h1>
        <span className={`w-2.5 h-2.5 rounded-full ${currentStatus.dotColor}`} />

        {/* Status dropdown */}
        <div className="relative" ref={statusDropdownRef}>
          <button
            onClick={() => !readOnly && setStatusDropdownOpen(!statusDropdownOpen)}
            disabled={readOnly}
            data-testid="entity-status-trigger"
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-body-small transition-colors hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: currentStatus.color }}
          >
            {entity.status}
            {!readOnly && (
              <ChevronRight className="w-3 h-3 rotate-90" />
            )}
          </button>

          {statusDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 min-w-[140px] rounded-lg border border-border bg-popover shadow-md py-1">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleStatusSelect(opt.value)}
                  disabled={opt.value === entity.status}
                  data-testid={`entity-status-option-${opt.value.toLowerCase()}`}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-body-small text-left hover:bg-accent/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: opt.color }}
                  />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <span
          data-testid="entity-version-state"
          className={`rounded-md border px-2 py-0.5 text-caption ${
            versionState.hasUnpublishedChanges && versionState.latestVersionLabel
              ? "border-warning/50 text-warning"
              : "border-border text-muted-foreground"
          }`}
        >
          {describeDraftState(versionState)}
        </span>

        {/* Saved flash indicator */}
        {showSaved && (
          <span data-testid="entity-saved-flash" className="flex items-center gap-1 text-caption text-success animate-auth-fade-up">
            <Check className="w-3 h-3" /> Saved
          </span>
        )}
        </div>

        <div className="flex items-center gap-space-2">
          {onPublish && (
            <Button size="sm" onClick={onPublish} className="gap-1.5" data-testid="publish-entity-button">
              <Upload className="w-3.5 h-3.5" />
              Publish
            </Button>
          )}
          {toolbar}
        </div>
      </div>

      {/* Status transition error */}
      {statusError && (
        <div data-testid="entity-status-error" className="mb-space-4 rounded-lg border border-destructive/50 bg-destructive/10 px-space-4 py-space-2 text-body-small text-destructive">
          {statusError}
        </div>
      )}

      {/* Deprecation inline form */}
      {showDeprecationForm && (
        <div data-testid="deprecation-form" className="mb-space-4 rounded-xl border px-space-4 py-space-4 space-y-space-3" style={{ borderColor: "#e88a3b", backgroundColor: "rgba(232,138,59,0.08)" }}>
          <h4 className="text-body-small font-medium text-foreground">Deprecation Details</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-3">
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">Deprecated Since</label>
              <Input
                type="date"
                data-testid="deprecation-since"
                value={depSince}
                onChange={(e) => setDepSince(e.target.value)}
                className="h-8 text-body-small"
              />
            </div>
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">Replacement Entity ID</label>
              <Input
                data-testid="deprecation-replacement"
                value={depReplacementEntityId}
                onChange={(e) => setDepReplacementEntityId(e.target.value)}
                placeholder="Entity ID (optional)"
                className="h-8 text-body-small"
              />
            </div>
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Migration Notes</label>
            <textarea
              data-testid="deprecation-notes"
              value={depMigrationNotes}
              onChange={(e) => setDepMigrationNotes(e.target.value)}
              placeholder="Optional migration guidance..."
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-body-small text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring resize-none"
              rows={3}
            />
          </div>
          <div className="flex items-center gap-space-2">
            <Button
              size="sm"
              data-testid="deprecation-submit"
              onClick={handleDeprecationSubmit}
              disabled={isPending}
            >
              {isPending ? "Saving..." : "Mark as Deprecated"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="deprecation-cancel"
              onClick={() => setShowDeprecationForm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Banners */}
      {entity.status === "DEPRECATED" && (
        <DeprecationBanner metadata={entity.metadata} replacementEntity={replacementEntity} />
      )}
      {entity.status === "RETIRED" && (
        <RetirementBanner metadata={entity.metadata} />
      )}

    </>
  );
}
