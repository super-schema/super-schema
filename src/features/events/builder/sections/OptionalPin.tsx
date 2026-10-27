"use client";

// src/features/events/builder/sections/OptionalPin.tsx
// An optional entity pin (a message's Headers or Message key) that takes no room until it is wanted: a `+ Add …` link while it is empty,
// the picker (`children`) once it holds an entity, reports a problem, or the user pressed the link. Once shown it stays shown, even if the
// entity is cleared again, so the picker does not vanish under the cursor. The form is rebuilt for each message, so the state is per message.
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { EntityPin } from "@/lib/events/types";

/** `id` prefixes the link's test id (`${id}-add`); `addLabel` is its text after the plus, e.g. "Add headers". */
export function OptionalPin({ id, addLabel, value, error, children }: {
  id: string; addLabel: string; value: EntityPin | null; error?: string; children: ReactNode;
}) {
  const [asked, setAsked] = useState(false);
  if (value !== null || error || asked) return <>{children}</>;
  return (
    <div>
      <Button
        type="button" variant="ghost" size="sm" data-testid={`${id}-add`} onClick={() => setAsked(true)}
        className="-ml-space-2 text-muted-foreground"
      >
        {`+ ${addLabel}`}
      </Button>
    </div>
  );
}
