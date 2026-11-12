"use client";
import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";

/** Raw JSON editor for an object value. Edits stay local until applied; invalid JSON cannot be applied. */
export function JsonObjectControl({
  label,
  value,
  stringsOnly = false,
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
  stringsOnly?: boolean;
  onChange: (v: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<{ original: string; text: string } | null>(
    null,
  );
  const stored = JSON.stringify(value, null, 2);
  const text = draft?.original === stored ? draft.text : stored;
  let error: string | undefined;
  try {
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      (stringsOnly &&
        !Object.values(parsed).every((v) => typeof v === "string"))
    )
      error = stringsOnly
        ? "Enter an object with string values."
        : "Enter a JSON object.";
  } catch {
    error = "Enter valid JSON.";
  }
  return (
    <FieldGroup>
      <AttributeControl
        label={label}
        help="Edit the JSON, then apply it to the field draft."
        error={error}
      >
        <Textarea
          value={text}
          rows={3}
          spellCheck={false}
          onChange={(e) => setDraft({ original: stored, text: e.target.value })}
        />
      </AttributeControl>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={Boolean(error) || text === stored}
        onClick={() => {
          onChange(JSON.parse(text));
          setDraft(null);
        }}
      >
        Apply {label.toLowerCase()}
      </Button>
    </FieldGroup>
  );
}
