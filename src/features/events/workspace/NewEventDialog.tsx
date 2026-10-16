"use client";

// src/features/events/workspace/NewEventDialog.tsx
// The product's "New Event" dialog (spec §3): a name, an optional description and the spec format. AsyncAPI 3.0 is the only format
// today, so its radio card is selected and cannot be unselected. The form is its own component inside the dialog content, so every
// opening starts empty (the dialog content is unmounted while closed).
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createEventAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { Field } from "@/features/events/builder/controls";
import { useCreateForm } from "./create-form";

/** Longest name the catalog accepts (`CATALOG_NAME_PATTERN`); the service owns the character rules and words its own error. */
const NAME_MAX_LENGTH = 128;

export function NewEventDialog({ productId, open, onOpenChange, onCreated }: {
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new event's id. The dialog stays busy afterwards: the caller navigates to the event. */
  onCreated: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="new-event-dialog">
        <NewEventForm productId={productId} onCancel={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function NewEventForm({ productId, onCancel, onCreated }: { productId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const formatId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  // `useCreateForm` is single-flight and stays busy after a success; a failure or a thrown action makes the form editable again.
  const form = useCreateForm((id) => {
    void invalidateDomainsTree();
    onCreated(id);
  });

  function submit() {
    if (form.busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Name is required.");
      return;
    }
    const trimmedDescription = description.trim();
    void form.run(() => createEventAction(productId, { name: trimmed, description: trimmedDescription === "" ? undefined : trimmedDescription }));
  }

  return (
    <form
      data-testid="new-event-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="grid gap-space-4"
    >
      <DialogHeader>
        <DialogTitle>New Event</DialogTitle>
        <DialogDescription>An event holds the whole AsyncAPI document of what this product sends and receives.</DialogDescription>
      </DialogHeader>

      <Field
        label="Name" htmlFor="new-event-name" error={nameError ?? undefined}
        hint={`Letters, digits, ".", "_" and "-" (up to ${NAME_MAX_LENGTH}). The name cannot be reused within this product.`}
      >
        <Input
          id="new-event-name" data-testid="new-event-name" aria-required="true" autoFocus autoComplete="off" spellCheck={false}
          maxLength={NAME_MAX_LENGTH} placeholder="checkout-events" value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameError(null);
          }}
        />
      </Field>

      <Field label="Description" htmlFor="new-event-description" hint="Optional. Shown at the top of the AsyncAPI document.">
        <Textarea
          id="new-event-description" data-testid="new-event-description" rows={3} value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <div role="radiogroup" aria-labelledby={`${formatId}-label`} className="space-y-space-1">
        <span id={`${formatId}-label`} className="block text-caption text-muted-foreground">Spec format</span>
        <label className="flex cursor-pointer items-start gap-space-3 rounded-lg border border-primary/40 bg-primary/5 p-space-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input
            type="radio" name="new-event-format" value="asyncapi@3.0" defaultChecked data-testid="new-event-format-asyncapi"
            className="mt-0.5 accent-primary"
          />
          <span>
            <span className="block text-body-small font-medium text-foreground">AsyncAPI 3.0</span>
            <span className="block text-caption text-muted-foreground">Servers, channels, messages and operations, built visually.</span>
          </span>
        </label>
      </div>

      {form.error && <p role="alert" data-testid="new-event-error" className="text-body-small text-destructive">{form.error}</p>}

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" data-testid="new-event-cancel" onClick={onCancel} disabled={form.busy}>Cancel</Button>
        <Button type="submit" size="sm" data-testid="new-event-submit" disabled={form.busy}>{form.busy ? "Creating…" : "Create"}</Button>
      </DialogFooter>
    </form>
  );
}
