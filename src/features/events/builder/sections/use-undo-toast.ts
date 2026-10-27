"use client";

// src/features/events/builder/sections/use-undo-toast.ts
// "Removed … — Undo": a toast whose Undo puts the document back as it was before the removal. Undo must never overwrite what the user
// did afterwards, so the toast belongs to ONE document (the one right after the removal): the next change to the document takes it
// down, and so does leaving the section that offered it. A newer offer takes the older one down.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { EventDocument } from "@/lib/events/document/types";

/**
 * How long the toast stays up, in milliseconds: long enough for a keyboard or screen-reader user to find it and press it. It is safe to
 * leave it up that long: it is taken down by the next change to the document, so Undo can never overwrite anything.
 */
const UNDO_TOAST_MS = 20_000;

type Pending = { id: string | number; after: EventDocument };

/**
 * `doc` is the draft's current document. The returned function shows the toast: `message` is its text, `after` the document the removal
 * produced (what `doc` is right after it), `undo` runs when Undo is pressed.
 */
export function useUndoToast(doc: EventDocument): (message: string, after: EventDocument, undo: () => void) => void {
  const [pending, setPending] = useState<Pending | null>(null);

  // The document moved on: the offer is void.
  if (pending !== null && pending.after !== doc) setPending(null);

  // The toast lives as long as `pending` holds it: when `pending` is cleared, replaced by a newer offer or the section goes away, it is taken down.
  useEffect(() => {
    if (pending === null) return undefined;
    return () => { toast.dismiss(pending.id); };
  }, [pending]);

  return (message, after, undo) => {
    const id = toast(message, {
      duration: UNDO_TOAST_MS,
      action: { label: "Undo", onClick: () => { setPending(null); undo(); } },
    });
    setPending({ id, after });
  };
}
