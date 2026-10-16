"use client";

// src/features/events/builder/template/controls/ChipsControl.tsx
// kind "stringList" | "tags": removable chips plus one input. Enter or a comma adds the typed text, leaving the field adds it too,
// and pasted text is split on commas and new lines. A tag is an object `{ name, … }` in AsyncAPI; its other properties (description,
// external docs) sit behind a details button per chip. A stringList (or tags without a nested template) holds plain strings.
import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Settings2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { isEmptyValue } from "../value";
import type { ControlProps } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The pieces of a pasted or typed text: split on commas and line breaks, trimmed, empty pieces dropped. */
function pieces(text: string): string[] {
  return text.split(/[,\n\r]+/).map((p) => p.trim()).filter(Boolean);
}

export function ChipsControl({ field, id, value, onChange, disabled, required, invalid, describedBy, placeholder, path, renderFields }: ControlProps) {
  const asObjects = field.kind === "tags" && field.fields !== undefined;
  const noun = field.kind === "tags" ? "tag" : "value";
  const raw: unknown[] = Array.isArray(value) ? value : [];
  const items = raw.map((r) => ({ raw: r, name: isRecord(r) ? String(r.name ?? "") : String(r) }));
  const [draft, setDraft] = useState("");
  const [openName, setOpenName] = useState<string | null>(null);
  const listId = field.suggestions?.length ? `${id}-options` : undefined;

  function add(names: string[]) {
    const taken = new Set(items.map((i) => i.name));
    const fresh = names.filter((n, i) => !taken.has(n) && names.indexOf(n) === i);
    if (fresh.length === 0) return;
    onChange([...raw, ...fresh.map((n) => (asObjects ? { name: n } : n))]);
  }
  function commit(text: string) {
    add(pieces(text));
    setDraft("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    }
  }
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/[,\n\r]/.test(text)) return;
    e.preventDefault();
    add(pieces(text));
  }
  function remove(index: number) {
    if (openName === items[index].name) setOpenName(null);
    onChange(raw.filter((_, i) => i !== index));
  }

  const openIndex = openName === null ? -1 : items.findIndex((i) => i.name === openName);
  const openItem = openIndex >= 0 ? raw[openIndex] : undefined;

  return (
    <div className="space-y-space-2">
      {items.length > 0 && (
        <ul aria-label={`${field.label} added`} className="flex flex-wrap gap-space-1">
          {items.map((item, index) => {
            const hasDetails = isRecord(item.raw) && Object.entries(item.raw).some(([k, v]) => k !== "name" && !isEmptyValue(v));
            return (
              <li
                key={`${index}-${item.name}`} data-testid={`${id}-chip-${index}`}
                className="inline-flex items-center gap-space-1 rounded-4xl bg-secondary px-space-2 py-0.5 text-caption text-secondary-foreground"
              >
                <span data-chip-text>{item.name}</span>
                {asObjects && (
                  <button
                    type="button" aria-label={`Edit details of tag ${item.name}`} aria-expanded={openName === item.name}
                    data-has-details={String(hasDetails)} data-testid={`${id}-chip-${index}-details`}
                    onClick={() => setOpenName(openName === item.name ? null : item.name)}
                    className="rounded-full p-0.5 outline-none hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 data-[has-details=true]:text-primary"
                  >
                    <Settings2 aria-hidden="true" className="size-3" />
                  </button>
                )}
                <button
                  type="button" aria-label={`Remove ${noun} ${item.name}`} disabled={disabled} data-testid={`${id}-chip-${index}-remove`}
                  onClick={() => remove(index)}
                  className="rounded-full p-0.5 outline-none hover:bg-background/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Input
        id={id} data-testid={id} value={draft} disabled={disabled} placeholder={placeholder ?? "Type and press Enter"} list={listId} autoComplete="off"
        aria-required={required || undefined} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
        onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} onBlur={() => commit(draft)}
      />
      {listId && <datalist id={listId}>{field.suggestions!.map((s) => <option key={s} value={s} />)}</datalist>}
      {asObjects && openIndex >= 0 && (
        <div
          role="group" aria-label={`Details of tag ${items[openIndex].name}`} data-testid={`${id}-${openIndex}`}
          className="space-y-space-3 rounded-md border border-border p-space-3"
        >
          {renderFields({
            fields: field.fields!,
            value: isRecord(openItem) ? openItem : { name: items[openIndex].name },
            onChange: (next) => onChange(raw.map((r, i) => (i === openIndex ? next : r))),
            idPrefix: `${id}-${openIndex}`,
            errorPrefix: `${path}/${openIndex}`,
            hideKeys: ["name"],
            defaultOpenMore: true,
          })}
        </div>
      )}
    </div>
  );
}
