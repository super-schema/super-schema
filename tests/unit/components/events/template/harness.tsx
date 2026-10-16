// tests/unit/components/events/template/harness.tsx
// Shared by the TemplateForm tests. Not a test file (vitest only collects *.test.tsx).
//   const { probe } = renderField(field("text"), { value: { thing: "x" } });
//   probe.value      // the object the form last handed to onChange (state lives in the harness, like a real section)
//   probe.onChange   // spy of every onChange call
//   probe.set(next)  // change the value from outside, like another part of the page editing the same document
import { useEffect, useState } from "react";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { TemplateForm, type TemplateFormProps } from "@/features/events/builder/template";
import type { FieldKind, FieldTemplate, ObjectTemplate } from "@/lib/events/templates";

/** A basics field with key `thing` / label `Thing`; override anything through `extra`. */
export function field(kind: FieldKind, extra: Partial<FieldTemplate> = {}): FieldTemplate {
  return { key: "thing", label: "Thing", kind, group: "basics", ...extra };
}

export function template(fields: FieldTemplate[], label = "Test form"): ObjectTemplate {
  return { id: "info", label, fields };
}

export type HarnessOptions = Partial<Omit<TemplateFormProps, "template" | "value" | "onChange">> & { value?: Record<string, unknown> };

export function renderForm(tpl: ObjectTemplate, options: HarnessOptions = {}) {
  const { value: initial = {}, ...props } = options;
  const probe = {
    value: initial as Record<string, unknown>,
    onChange: vi.fn<(next: Record<string, unknown>) => void>(),
    set: (() => {}) as (next: Record<string, unknown>) => void,
  };
  function Harness() {
    const [value, setValue] = useState<Record<string, unknown>>(initial);
    useEffect(() => {
      Object.assign(probe, { value, set: (next: Record<string, unknown>) => act(() => setValue(next)) });
    });
    return (
      <TemplateForm
        template={tpl}
        value={value}
        idPrefix="f"
        {...props}
        onChange={(next) => {
          probe.onChange(next);
          setValue(next);
        }}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, probe };
}

export function renderField(f: FieldTemplate, options: HarnessOptions = {}) {
  return renderForm(template([f]), options);
}
