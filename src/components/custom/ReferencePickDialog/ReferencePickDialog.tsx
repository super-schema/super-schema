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
}

/** "Which entity do you mean?": the candidates as `domain / product / entity`; choosing one calls `onPick` with it. */
export function ReferencePickDialog({ candidates, onPick, onCancel }: ReferencePickDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-testid="reference-pick-dialog">
        <DialogHeader>
          <DialogTitle>Choose the referenced entity</DialogTitle>
          <DialogDescription>
            More than one entity matches. The choice is saved on the field as a fully qualified reference.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-64 flex-col gap-space-2 overflow-y-auto">
          {candidates.map((candidate) => {
            const label = `${candidate.domain} / ${candidate.product} / ${candidate.entity}`;
            return (
              <li key={candidate.entityId ?? label}>
                <button
                  type="button"
                  className="w-full rounded border border-border/50 px-space-2 py-space-1 text-left font-mono text-body-small hover:bg-accent/30"
                  onClick={() => onPick(candidate)}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
