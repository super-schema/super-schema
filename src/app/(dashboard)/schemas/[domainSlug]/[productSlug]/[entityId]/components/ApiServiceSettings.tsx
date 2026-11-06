"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldError, LABEL } from "./ApiFormControls";

export interface ApiServiceInfo {
  id: string;
  name: string;
  basePath: string;
}

interface ApiServiceSettingsProps {
  service: ApiServiceInfo;
  readOnly: boolean;
  /** Resolves with an error text, or null when saved. */
  onSave: (changes: { name: string; basePath: string }) => Promise<string | null>;
  onClose: () => void;
}

/** Name and base path of the entity's API service, saved explicitly. */
export function ApiServiceSettings({ service, readOnly, onSave, onClose }: ApiServiceSettingsProps) {
  const [name, setName] = useState(service.name);
  const [basePath, setBasePath] = useState(service.basePath);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== service.name || (basePath.trim() || "/") !== service.basePath;
  const pathInvalid = !(basePath.trim() || "/").startsWith("/");

  const save = async () => {
    setBusy(true);
    const failure = await onSave({ name: name.trim(), basePath: basePath.trim() || "/" });
    setBusy(false);
    setError(failure);
    if (!failure) onClose();
  };

  return (
    <div data-testid="api-service-settings" className="rounded-lg border border-border/50 bg-muted/20 p-space-3 space-y-space-2">
      <div className="grid grid-cols-2 gap-space-2">
        <div>
          <label htmlFor="api-service-name" className={LABEL}>Service name</label>
          <Input id="api-service-name" data-testid="api-service-name" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-caption font-mono" disabled={readOnly} aria-invalid={!name.trim() || undefined} />
          <FieldError message={!name.trim() ? "Service name is required" : undefined} />
        </div>
        <div>
          <label htmlFor="api-service-base-path" className={LABEL}>Base path</label>
          <Input id="api-service-base-path" data-testid="api-service-base-path" value={basePath} onChange={(e) => setBasePath(e.target.value)} placeholder="/" className="h-7 text-caption font-mono" disabled={readOnly} aria-invalid={pathInvalid || undefined} />
          <FieldError message={pathInvalid ? 'Base path must start with "/"' : undefined} />
        </div>
      </div>
      <FieldError message={error ?? undefined} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        {!readOnly && (
          <Button size="sm" data-testid="api-service-save" disabled={!dirty || !name.trim() || pathInvalid || busy} onClick={() => void save()}>
            Save settings
          </Button>
        )}
      </div>
    </div>
  );
}
