"use client";

// src/features/events/builder/template/controls/ObjectControl.tsx
// kind "object": the child fields, rendered by the form itself (FieldControl draws the bordered group around them). The whole
// object disappears from the value when every child is empty; properties the template does not know are carried along.
import type { ControlProps } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function ObjectControl({ field, id, value, onChange, path, renderFields }: ControlProps) {
  return <>{renderFields({ fields: field.fields ?? [], value: isRecord(value) ? value : {}, onChange, idPrefix: id, errorPrefix: path })}</>;
}
