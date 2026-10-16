// src/lib/events/templates/index.ts
// AsyncAPI template catalog: every property of every AsyncAPI 3.0 object as a ready-made form template, protocol binding
// templates, and generated identifiers. Pure TypeScript — client-safe.
export type {
  BindingTarget, BindingTemplateId, FieldKind, FieldTemplate, ObjectTemplate, ObjectTemplateId, ReferenceTarget,
} from "./types";
export { TEMPLATES } from "./objects";
export { BINDING_PROTOCOLS, bindingProtocolLabel, bindingTemplate, bindingVersion } from "./bindings";
export { suggestKey } from "./keys";
export type { KeyKind } from "./keys";
