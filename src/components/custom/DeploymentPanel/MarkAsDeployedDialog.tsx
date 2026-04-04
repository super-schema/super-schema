"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface MarkAsDeployedDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (environment: string) => void;
  targetFormat: string;
  version: string;
  entityName: string;
}

const PREDEFINED_ENVIRONMENTS = ["production", "staging", "development"];

export function MarkAsDeployedDialog({
  isOpen,
  onClose,
  onConfirm,
  targetFormat,
  version,
  entityName,
}: MarkAsDeployedDialogProps) {
  const [environment, setEnvironment] = useState("production");
  const [customEnv, setCustomEnv] = useState("");
  const [useCustom, setUseCustom] = useState(false);

  if (!isOpen) return null;

  function handleConfirm() {
    const env = useCustom ? customEnv.trim() : environment;
    if (!env) return;
    onConfirm(env);
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
              <span className="font-mono text-foreground">{version}</span> as
              deployed to{" "}
              <span className="text-foreground font-medium">
                {targetFormat}
              </span>
            </p>
          </div>

          {/* Environment selector */}
          <div>
            <label className="text-caption text-muted-foreground block mb-1">
              Environment
            </label>
            {!useCustom ? (
              <div className="space-y-2">
                <select
                  data-testid="environment-selector"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  className="w-full bg-muted rounded-lg px-space-3 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary"
                >
                  {PREDEFINED_ENVIRONMENTS.map((env) => (
                    <option key={env} value={env}>
                      {env}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setUseCustom(true)}
                  className="text-caption text-primary hover:underline"
                >
                  Use custom environment name
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={customEnv}
                  onChange={(e) => setCustomEnv(e.target.value)}
                  placeholder="e.g., qa, pre-prod, canary"
                  className="w-full bg-muted rounded-lg px-space-3 py-1.5 text-body-small text-foreground placeholder:text-muted-foreground outline-none border border-border focus:border-primary"
                />
                <button
                  onClick={() => setUseCustom(false)}
                  className="text-caption text-primary hover:underline"
                >
                  Use predefined environment
                </button>
              </div>
            )}
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
            disabled={useCustom && !customEnv.trim()}
            className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
