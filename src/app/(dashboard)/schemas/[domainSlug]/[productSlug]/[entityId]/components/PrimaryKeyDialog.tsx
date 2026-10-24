"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MissingRequirement } from "@/lib/schema-targets/requirements";

interface PrimaryKeyDialogProps {
  requirement: MissingRequirement;
  /**
   * Called with the chosen field names (declaration order). May be async: a returned string is shown inline as the failure
   * (the dialog stays open); no return value means it worked and the parent closes the dialog.
   */
  onConfirm: (fieldNames: string[]) => void | string | Promise<void | string>;
  onCancel: () => void;
}

/** "This target needs a primary key": the entity's fields as checkboxes (composite keys allowed), `suggested` pre-checked. */
export function PrimaryKeyDialog({ requirement, onConfirm, onCancel }: PrimaryKeyDialogProps) {
  const [selected, setSelected] = useState<string[]>(() =>
    requirement.candidates.filter((name) => requirement.suggested.includes(name)),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (name: string, checked: boolean) =>
    setSelected((current) => (checked ? [...current, name] : current.filter((n) => n !== name)));

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const names = requirement.candidates.filter((name) => selected.includes(name));
      const failure = await onConfirm(names);
      if (typeof failure === "string") setError(failure);
    } catch {
      setError("Could not save the primary key");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent data-testid="primary-key-dialog">
        <DialogHeader>
          <DialogTitle>This target needs a primary key</DialogTitle>
          <DialogDescription>{requirement.message}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex max-h-64 flex-col gap-space-2 overflow-y-auto" disabled={pending}>
          <legend className="mb-space-2 text-body-small text-muted-foreground">
            Pick one field, or several for a composite key. It is saved on the entity and used for every target.
          </legend>
          {requirement.candidates.length === 0 && (
            <p className="text-body-small text-muted-foreground">This entity has no fields to choose from. Add a field first.</p>
          )}
          {requirement.candidates.map((name) => (
            <label key={name} className="flex items-center gap-space-2 text-body-small">
              <input
                type="checkbox"
                data-testid="primary-key-option"
                data-field={name}
                checked={selected.includes(name)}
                onChange={(event) => toggle(name, event.target.checked)}
              />
              <span className="font-mono">{name}</span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-body-small text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending} data-testid="primary-key-cancel">
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirm()} disabled={pending || selected.length === 0} data-testid="primary-key-confirm">
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Save key and generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
