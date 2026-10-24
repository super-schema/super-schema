"use client";

import { useEffect, useState } from "react";
import { Loader2, Pin } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * What a reference field's pin control needs of the server, handed in by the workspace so this component (and the field row that
 * hosts it) never import a server action themselves.
 */
export interface ReferenceFieldControls {
  /** The PUBLISHED versions of an entity as labels ("2.1"), newest first. Every stored version is published: a draft is never one. */
  listPublishedVersions(entityId: string): Promise<{ labels: string[] } | { error: string }>;
  /** Pins `pinnedVersion` on the reference field (`null` removes the pin). Resolves to the refusal's message, or nothing when saved. */
  setPin(args: { fieldId: string; referencedEntityId: string; pinnedVersion: string | null }): Promise<{ error: string } | undefined>;
}

interface ReferencePinControlProps {
  /** The reference field the pin is stored on. */
  fieldId: string;
  /** The entity the field references (`decorators.referencedEntityId`): its published versions are what can be pinned. */
  referencedEntityId: string;
  /** `domain / product / entity` of the referenced entity, for the accessible name. */
  referenceLabel?: string;
  /** The pin the field carries (`decorators.referencedEntityVersion`), if any. */
  pinnedVersion?: string;
  /** Without controls, or when disabled (a read-only entity), the pin is only shown. */
  controls?: ReferenceFieldControls;
  disabled?: boolean;
}

type Versions = { state: "idle" } | { state: "loading" } | { state: "ready"; labels: string[] } | { state: "failed"; message: string };

/**
 * The pin of a reference field. Unpinned (the default) a reference means the latest published version (or, generating a draft, the
 * latest saved one); a pin freezes it to one PUBLISHED version of the referenced entity and is the only thing that stores a version on
 * the reference. Shows the pin as a badge; "Pin version" / "Change pin" opens a list of the published versions plus "Latest published
 * (no pin)", which removes the pin. The versions are loaded when the list is opened, not for every row up front.
 */
export function ReferencePinControl({ fieldId, referencedEntityId, referenceLabel, pinnedVersion, controls, disabled = false }: ReferencePinControlProps) {
  // What this control last saved, shown until the field it belongs to carries the new pin itself (the server re-renders it).
  const [saved, setSaved] = useState<{ pin: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Versions>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSaved(null);
  }, [pinnedVersion]);

  const pin = saved ? saved.pin : pinnedVersion ?? null;
  const name = referenceLabel ?? "the referenced entity";

  async function handleOpen() {
    if (!controls) return;
    setOpen(true);
    setSaveError(null);
    setVersions({ state: "loading" });
    try {
      const result = await controls.listPublishedVersions(referencedEntityId);
      setVersions("error" in result ? { state: "failed", message: result.error } : { state: "ready", labels: result.labels });
    } catch {
      setVersions({ state: "failed", message: "Could not load the published versions. Try again." });
    }
  }

  async function handleChange(value: string) {
    if (!controls) return;
    const next = value === "" ? null : value;
    setSaving(true);
    setSaveError(null);
    try {
      const refused = await controls.setPin({ fieldId, referencedEntityId, pinnedVersion: next });
      if (refused) {
        setSaveError(refused.error);
        return;
      }
      setSaved({ pin: next });
      setOpen(false);
    } catch {
      setSaveError("Could not save the pin. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const badge = pin ? (
    <Badge variant="info" data-testid="reference-pin-badge" className="h-4 px-1 text-[10px]" title={`Pinned to ${name} v${pin}`}>
      <Pin aria-hidden="true" />
      pinned v{pin}
    </Badge>
  ) : null;

  if (!controls || disabled) return badge;

  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="reference-pin">
      {badge}
      {!open && (
        <button
          type="button"
          data-testid="reference-pin-open"
          onClick={() => void handleOpen()}
          className="rounded px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`${pin ? "Change the pin of" : "Pin a version of"} ${name}`}
          title="Pin a published version of the referenced entity"
        >
          {pin ? "Change pin" : "Pin version"}
        </button>
      )}
      {open && (
        <span className="inline-flex flex-wrap items-center gap-1">
          {versions.state === "loading" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Loading versions" />}
          {versions.state === "failed" && (
            <span role="alert" className="text-[10px] text-destructive">
              {versions.message}
            </span>
          )}
          {versions.state === "ready" && (
            <>
              <select
                data-testid="reference-pin-control"
                aria-label={`Pinned version of ${name}`}
                value={pin ?? ""}
                disabled={saving}
                onChange={(e) => void handleChange(e.target.value)}
                className="h-5 rounded border border-input bg-background px-1 text-[10px] text-foreground"
              >
                <option value="">Latest published (no pin)</option>
                {versions.labels.map((label) => (
                  <option key={label} value={label}>
                    v{label}
                  </option>
                ))}
                {/* A pin to a version that is gone stays selectable only as what it is, so the select never lies about the field. */}
                {pin && !versions.labels.includes(pin) && <option value={pin}>v{pin} (not found)</option>}
              </select>
              {versions.labels.length === 0 && (
                <span data-testid="reference-pin-none-published" className="text-[10px] text-muted-foreground">
                  {name} has never been published, so there is no version to pin.
                </span>
              )}
            </>
          )}
          {saveError && (
            <span role="alert" className="text-[10px] text-destructive">
              {saveError}
            </span>
          )}
          <button
            type="button"
            data-testid="reference-pin-cancel"
            onClick={() => setOpen(false)}
            disabled={saving}
            className="rounded px-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Close
          </button>
        </span>
      )}
    </span>
  );
}
