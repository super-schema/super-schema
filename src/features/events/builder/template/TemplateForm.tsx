"use client";

// src/features/events/builder/template/TemplateForm.tsx
// Renders any `ObjectTemplate` (src/lib/events/templates) against a plain AsyncAPI-shaped value object. It never sees the
// EventDocument: a section hands it a piece of the document and takes back the next piece. The value it returns is already cleaned
// (empty strings, arrays and objects are removed) and carries every property the template does not know, untouched.
import { useMemo } from "react";
import type { ObjectTemplate } from "@/lib/events/templates";
import type { FormEnv, FormProblem, TemplateFormContext } from "./controls/types";
import { FieldGroups } from "./FieldControl";

export type { ReferenceOption, TemplateFormContext } from "./controls/types";

export interface TemplateFormProps {
  template: ObjectTemplate;
  value: Record<string, unknown>;
  /** The next value, already cleaned: empty string / array / object values removed. */
  onChange: (next: Record<string, unknown>) => void;
  /** Ids and test ids are `${idPrefix}-${field.key}`; nested fields `${idPrefix}-${parent}-${child}`. */
  idPrefix: string;
  errors?: Array<FormProblem>;
  /** A field's problems are those whose pointer equals or continues `${errorPrefix}/${key}`. */
  errorPrefix?: string;
  context?: TemplateFormContext;
  disabled?: boolean;
  /** Fields the caller draws itself (an entity pin, an identifier). Their values are kept as they are. */
  hideKeys?: string[];
  defaultOpenMore?: boolean;
}

export function TemplateForm({ template, value, onChange, idPrefix, errors, errorPrefix = "", context, disabled, hideKeys, defaultOpenMore }: TemplateFormProps) {
  const env = useMemo<FormEnv>(() => ({ context, errors, disabled, defaultOpenMore }), [context, errors, disabled, defaultOpenMore]);
  const safe = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  return (
    <FieldGroups fields={template.fields} value={safe} onChange={onChange} idPrefix={idPrefix} errorPrefix={errorPrefix} env={env} hideKeys={hideKeys} />
  );
}
