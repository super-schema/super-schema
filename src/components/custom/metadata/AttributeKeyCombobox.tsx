"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import { METADATA_ATTRIBUTE_KEY_REGEX, type MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";

interface Props {
  /** Definitions already filtered to the target being edited. */
  definitions: MetadataAttributeDefinition[];
  /** Keys already set; they are not suggested again. */
  existingKeys: string[];
  /** The definition is undefined for a free-typed key the dictionary does not define. */
  onPick: (key: string, definition?: MetadataAttributeDefinition) => void;
  /** Offer a free-typed `x-…` key (default true). */
  allowFreeKey?: boolean;
}

/** Suggests dictionary keys (label, key, description) as the user types; a free-typed `x-…` key is still allowed. */
export function AttributeKeyCombobox({ definitions, existingKeys, onPick, allowFreeKey = true }: Props) {
  const [text, setText] = useState("");
  const query = text.trim().toLowerCase();
  const matches = query
    ? definitions.filter(
        (d) => !existingKeys.includes(d.key) && (d.key.toLowerCase().includes(query) || d.label.toLowerCase().includes(query)),
      )
    : [];
  const typed = text.trim();
  const freeKey =
    allowFreeKey && METADATA_ATTRIBUTE_KEY_REGEX.test(typed) && !existingKeys.includes(typed) && !definitions.some((d) => d.key === typed) ? typed : null;

  function pick(key: string, definition?: MetadataAttributeDefinition) {
    onPick(key, definition);
    setText("");
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <AttributeControl label="Attribute key">
        <Input value={text} spellCheck={false} placeholder="x-…" onChange={(e) => setText(e.target.value)} />
      </AttributeControl>
      {matches.length > 0 && (
        <ul role="listbox" aria-label="Matching attributes" className="flex flex-col rounded-md border border-border">
          {matches.map((d) => (
            <li
              key={d.key}
              role="option"
              aria-selected={false}
              tabIndex={0}
              className="cursor-pointer px-2 py-1.5 text-sm hover:bg-muted focus-visible:bg-muted"
              onClick={() => pick(d.key, d)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(d.key, d);
                }
              }}
            >
              {d.label} ({d.key})
              {d.description && <span className="block text-xs text-muted-foreground">{d.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {freeKey && (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => pick(freeKey)}>
          Use {freeKey}
        </Button>
      )}
    </div>
  );
}
