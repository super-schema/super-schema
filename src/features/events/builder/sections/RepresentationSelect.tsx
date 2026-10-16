"use client";

// src/features/events/builder/sections/RepresentationSelect.tsx
// The message's "Payload representation": Auto (recommended) / Avro / JSON Schema / Protobuf, and always, under it, one line saying
// what that means for this message right now (what Auto resolved to and why, or what the user chose). Auto is the absence of the
// property; the sentence comes from `representationNote`, which asks the same resolver the server uses (round-2 R4).
import type { PayloadFormat } from "@/lib/event-specs/types";
import { cn } from "@/lib/utils";
import { selectClass } from "../controls";
import type { RepresentationNote } from "./representation-note";

const CHOICES: Array<{ value: "" | PayloadFormat; label: string }> = [
  { value: "", label: "Auto (recommended)" },
  { value: "avro", label: "Avro" },
  { value: "json-schema", label: "JSON Schema" },
  { value: "protobuf", label: "Protobuf" },
];

/**
 * `id` is the id and test id of the select; `${id}-explanation` is the sentence (linked with `aria-describedby`) and `${id}-error`
 * a problem the document reports for the property. `value` is "" for Auto. `onChange` gets "" for Auto, else the format.
 */
export function RepresentationSelect({ id, value, onChange, note, error }: {
  id: string; value: "" | PayloadFormat; onChange: (next: "" | PayloadFormat) => void; note: RepresentationNote; error?: string;
}) {
  const noteId = `${id}-explanation`;
  const errorId = `${id}-error`;
  return (
    <div className="space-y-space-1">
      <label htmlFor={id} className="block text-caption text-muted-foreground">Payload representation</label>
      <select
        id={id} data-testid={id} className={selectClass} value={value} aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errorId : null, noteId].filter(Boolean).join(" ")}
        onChange={(e) => onChange(e.target.value as "" | PayloadFormat)}
      >
        {CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <p
        id={noteId} data-testid={noteId} data-tone={note.tone}
        className={cn("text-caption", note.tone === "hint" ? "text-muted-foreground" : "text-foreground")}
      >
        {note.text}
      </p>
      {error && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{error}</p>}
    </div>
  );
}
