"use client";

// The product page's "Edit contacts" dialog: the same three inputs as the create form (`ProductContactFields`), checked with the
// same code (`resolveProductContactsDraft`). Only the contact fields are sent to `updateProductAction`, so no other product field
// is touched; an emptied field is saved as cleared (null / []). The form is its own component inside the dialog content, so every
// opening starts from the stored contacts (the dialog content is unmounted while closed).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resolveProductContactsDraft } from "@/lib/product-contacts";
import type { ProductContactErrors, ProductContactsDraft } from "@/lib/product-contacts";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";
import { updateProductAction } from "../product-actions";
import { ProductContactFields } from "./ProductContactFields";
import type { ProductContactsValue } from "./ProductContacts";

/** The stored contacts as the form's draft: canonical text in the inputs and one chip per team address, nothing pending. */
function draftOf(contacts: ProductContactsValue): ProductContactsDraft {
  return {
    engineeringLead: contacts.engineeringLead ?? "",
    manager: contacts.manager ?? "",
    teamEmails: (contacts.teamEmails ?? []).filter((stored) => stored.trim() !== ""),
    teamDraft: "",
  };
}

export function EditProductContactsDialog({ productId, productName, contacts, open, onOpenChange }: {
  productId: string;
  productName: string;
  /** What is stored now: the inputs start from it each time the dialog opens. */
  contacts: ProductContactsValue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // While a save is in flight the dialog cannot be dismissed (Escape, a click outside, the X): the user must see its outcome,
  // and a failure would otherwise land on a closed dialog.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      disablePointerDismissal={busy}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy} data-testid="edit-product-contacts-dialog">
        <EditContactsForm
          productId={productId}
          productName={productName}
          contacts={contacts}
          busy={busy}
          onBusyChange={setBusy}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function EditContactsForm({ productId, productName, contacts, busy, onBusyChange, onClose }: {
  productId: string;
  productName: string;
  contacts: ProductContactsValue;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<ProductContactsDraft>(() => draftOf(contacts));
  const [fieldErrors, setFieldErrors] = useState<ProductContactErrors>({});
  const [error, setError] = useState<string | null>(null);
  // A second submit in the same tick would still see `busy === false` in its closure.
  const inFlight = useRef(false);

  function edit(next: ProductContactsDraft) {
    setDraft(next);
    // The form-level server message was about the values that were submitted: the first edit retires it (a field's own message
    // clears per field, in `ProductContactFields`).
    setError(null);
  }

  async function submit() {
    if (inFlight.current) return;
    // The same rules the create form and the service apply; every bad field is shown at once.
    const resolved = resolveProductContactsDraft(draft);
    setFieldErrors(resolved.success ? {} : resolved.error);
    setError(null);
    if (!resolved.success) return;

    inFlight.current = true;
    onBusyChange(true);
    try {
      // Only the contact fields: the service leaves every field that is absent from the input alone.
      const result = await updateProductAction(productId, {
        engineeringLead: resolved.data.engineeringLead,
        manager: resolved.data.manager,
        teamEmails: resolved.data.teamEmails,
      });
      if (result.error) {
        // A contact validation failure from the server lands next to its input; anything else is the form-level message.
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        else setError(result.error);
        return;
      }
      toast.success("Contacts updated");
      onClose();
      router.refresh();
    } catch (e: unknown) {
      // A rejected action (network, serialization, an unwrapped server throw) must not leave the dialog stuck on "Saving…".
      console.error("[edit-product-contacts] update product failed", e);
      setError(GENERIC_ACTION_ERROR);
    } finally {
      inFlight.current = false;
      onBusyChange(false);
    }
  }

  return (
    <form
      data-testid="edit-product-contacts-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="grid gap-space-4"
    >
      <DialogHeader>
        <DialogTitle>Edit contacts</DialogTitle>
        <DialogDescription>
          Who to reach about {productName}. All three are optional; clear a field to remove it.
        </DialogDescription>
      </DialogHeader>

      <ProductContactFields value={draft} errors={fieldErrors} onChange={edit} onErrorsChange={setFieldErrors} disabled={busy} />

      {error && <p role="alert" data-testid="edit-product-contacts-error" className="text-body-small text-destructive">{error}</p>}

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" data-testid="edit-product-contacts-cancel" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" data-testid="edit-product-contacts-save" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </DialogFooter>
    </form>
  );
}
