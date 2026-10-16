"use client";

// src/features/events/builder/Identifier.tsx
// The one place a generated key is shown and, if the user insists, renamed (round-2 R3). Every keyed item (server, channel, message,
// operation, trait) puts this under its form: a collapsed "Identifier" that shows the key and, when opened, the rename input.
// A rename goes through `onRename`, which should use `renameKey` so every reference follows.
import { KeyInput } from "./controls";

export const IDENTIFIER_HELP = "Used to refer to this item inside the document. Generated for you — rename only if you need a specific name.";

/**
 * `id` is the id and test id of the rename input (`server-key`); the rest derive from it: `${id}-disclosure` (the `<details>`),
 * `${id}-toggle` (its summary), `${id}-value` (the key as text, always visible) and `${id}-help`.
 * `taken` = the other keys of the item's namespace; `onRename(next)` is called only with a key that is valid and not taken.
 * `error` is a problem the document reports for the key itself (a duplicate, a reserved name): it opens the disclosure and shows under the input.
 */
export function IdentifierDisclosure({ id, value, taken, onRename, label = "Identifier", error }: {
  id: string; value: string; taken: string[]; onRename: (next: string) => void; label?: string; error?: string;
}) {
  return (
    <details open={error ? true : undefined} data-testid={`${id}-disclosure`} className="rounded-md border border-border bg-muted/20 px-space-3 py-space-2">
      <summary
        data-testid={`${id}-toggle`}
        className="flex cursor-pointer list-none items-center gap-space-2 rounded-md text-caption text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
      >
        <span>{label}</span>
        <code data-testid={`${id}-value`} className="min-w-0 truncate rounded bg-muted px-space-1 font-mono text-foreground">{value}</code>
      </summary>
      <div className="mt-space-2 space-y-space-2">
        <p id={`${id}-help`} data-testid={`${id}-help`} className="text-caption text-muted-foreground">{IDENTIFIER_HELP}</p>
        <KeyInput id={id} label={label} value={value} taken={taken} onCommit={onRename} error={error} />
      </div>
    </details>
  );
}
