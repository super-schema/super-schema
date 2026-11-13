"use client";
import { useId, useState, type KeyboardEvent } from "react";
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

export const KEY_PREFIX_HELP = "Keys must start with x-";

/**
 * Suggests dictionary keys (label, key, description): a combobox (WAI-ARIA list autocomplete). The list opens on focus with every key not set
 * yet and narrows as the user types; ArrowDown / ArrowUp move through it, Enter picks, Escape closes. A free-typed `x-…` key is still
 * allowed when `allowFreeKey`; a typed key without the `x-` prefix that matches nothing is explained.
 */
export function AttributeKeyCombobox({ definitions, existingKeys, onPick, allowFreeKey = true }: Props) {
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-option-${i}`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = text.trim().toLowerCase();
  const available = definitions.filter((d) => !existingKeys.includes(d.key));
  const matches = query ? available.filter((d) => d.key.toLowerCase().includes(query) || d.label.toLowerCase().includes(query)) : available;
  const typed = text.trim();
  const freeKey =
    allowFreeKey && METADATA_ATTRIBUTE_KEY_REGEX.test(typed) && !existingKeys.includes(typed) && !definitions.some((d) => d.key === typed) ? typed : null;
  const needsPrefix = typed !== "" && !typed.toLowerCase().startsWith("x-") && matches.length === 0;
  const expanded = open && matches.length > 0;
  const current = expanded && active >= 0 && active < matches.length ? active : -1;

  function pick(key: string, definition?: MetadataAttributeDefinition) {
    onPick(key, definition);
    setText("");
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((i) => (e.key === "ArrowDown" ? Math.min(i + 1, matches.length - 1) : Math.max(i - 1, 0)));
      return;
    }
    if (e.key === "Enter" && current >= 0) {
      e.preventDefault();
      pick(matches[current].key, matches[current]);
      return;
    }
    if (e.key === "Escape" && expanded) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <AttributeControl label="Attribute key" help={needsPrefix ? KEY_PREFIX_HELP : undefined}>
        <Input
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="x-…"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
      </AttributeControl>
      {expanded && (
        <ul id={listId} role="listbox" aria-label="Matching attributes" className="flex max-h-60 flex-col overflow-y-auto rounded-md border border-border">
          {matches.map((d, i) => (
            <li
              key={d.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={`cursor-pointer px-2 py-1.5 text-sm hover:bg-muted ${i === current ? "bg-muted" : ""}`}
              // Keep the focus in the input (no blur closing the list before the click lands).
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(d.key, d)}
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
