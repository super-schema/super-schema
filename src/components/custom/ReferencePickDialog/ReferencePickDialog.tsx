"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EntityRef } from "@/lib/references/entity-reference";

interface ReferencePickDialogProps {
  candidates: EntityRef[];
  onPick: (ref: EntityRef) => void;
  onCancel: () => void;
  /** The reference field that asks and the name it refers to: when both are given the dialog says which reference it is about. */
  field?: string;
  name?: string;
  /** Why the last pick was not saved; shown in the dialog, which stays open. */
  error?: string | null;
  /** A pick is being saved: the candidates cannot be chosen again meanwhile. */
  saving?: boolean;
}

/** "Which entity do you mean?": the candidates as `domain / product / entity`; choosing one calls `onPick` with it. */
export function ReferencePickDialog({ candidates, onPick, onCancel, field, name, error, saving = false }: ReferencePickDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <DialogContent data-testid="reference-pick-dialog">
        <DialogHeader>
          <DialogTitle>Choose the referenced entity</DialogTitle>
          <DialogDescription>
            {field !== undefined && name !== undefined
              ? `Field "${field}" refers to "${name}", which matches ${candidates.length} entities. Choose the one it means. `
              : "More than one entity matches. "}
            The choice is saved on the field as a fully qualified reference.
          </DialogDescription>
        </DialogHeader>
        <ul data-testid="reference-pick-candidates" className="flex max-h-64 flex-col gap-space-2 overflow-y-auto">
          {candidates.map((candidate, index) => {
            const label = `${candidate.domain} / ${candidate.product} / ${candidate.entity}`;
            return (
              <li key={`${index}:${candidate.entityId ?? label}`}>
                <button
                  type="button"
                  data-testid="reference-pick-candidate"
                  data-entity-id={candidate.entityId}
                  disabled={saving}
                  className="w-full rounded border border-border/50 px-space-2 py-space-1 text-left font-mono text-body-small hover:bg-accent/30 disabled:opacity-50"
                  onClick={() => onPick(candidate)}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
        {error && (
          <p role="alert" data-testid="reference-pick-error" className="text-body-small text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
