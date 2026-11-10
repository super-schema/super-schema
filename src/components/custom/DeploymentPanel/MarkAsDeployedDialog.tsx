"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface MarkAsDeployedDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (environment: string, version?: string) => void;
  versions?: number[];
  targetFormat: string;
  version: string;
  entityName: string;
  environments?: string[];
}

export function MarkAsDeployedDialog({
  isOpen,
  onClose,
  onConfirm,
  targetFormat,
  version,
  entityName,
  environments = [],
  versions,
}: MarkAsDeployedDialogProps) {
  const [selectedVersion, setSelectedVersion] = useState(version);
  const [environment, setEnvironment] = useState(environments[0] ?? "");

  if (!isOpen) return null;

  function handleConfirm() {
    const env = environment;
    if (!environments.includes(env)) return;
    onConfirm(env, selectedVersion);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        data-testid="mark-deployed-dialog"
        className="bg-background border border-border rounded-xl shadow-xl w-[400px]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-space-4 py-space-3 border-b border-border">
          <h3 className="text-heading-3 text-foreground">
            Mark as Deployed
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-accent"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="p-space-4 space-y-space-4">
          {/* Version confirmation */}
          <div className="bg-muted rounded-lg p-space-3">
            <p className="text-caption text-muted-foreground">
              Mark{" "}
              <span className="text-foreground font-medium">{entityName}</span>{" "}
              version{" "}
              <span className="font-mono text-foreground">{selectedVersion}</span> as
              deployed to{" "}
              <span className="text-foreground font-medium">
                {targetFormat}
              </span>
            </p>
          </div>

          {versions && <div><label htmlFor="record-version" className="mb-1 block text-sm font-medium">Published artifact version</label><select id="record-version" value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)} className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">{versions.map((v) => <option key={v} value={`v${v}`}>v{v}</option>)}</select></div>}
          {/* Environment selector */}
          <div>
            <label htmlFor="record-environment" className="text-caption text-muted-foreground block mb-1">
              Environment
            </label>
            <select id="record-environment" data-testid="environment-selector" value={environment} onChange={(e) => setEnvironment(e.target.value)} className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground">
              {!environments.length && <option value="">Configure environments in settings</option>}
              {environments.map((env) => <option key={env} value={env}>{env}</option>)}
            </select>
            <a href="/admin/settings/deployments" className="text-sm text-primary underline">Manage environments in settings</a>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-space-2 px-space-4 py-space-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-body-small text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            data-testid="confirm-deploy-button"
            onClick={handleConfirm}
            disabled={!environments.includes(environment)}
            className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
