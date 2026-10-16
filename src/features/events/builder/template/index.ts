// src/features/events/builder/template/index.ts
// The template form engine: render any AsyncAPI object template (or a protocol binding) as a form where the user only fills values.
// Pure client UI; it does not know the EventDocument.
export { TemplateForm } from "./TemplateForm";
export type { TemplateFormProps } from "./TemplateForm";
export { BindingsForm } from "./BindingsForm";
export type { BindingsFormProps } from "./BindingsForm";
export type { ReferenceOption, TemplateFormContext } from "./controls/types";
export { isEmptyValue, setField } from "./value";
