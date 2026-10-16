// src/lib/events/templates/types.ts
// Template catalog types (round-2 plan WP-T). Pure types — client-safe.
//
// A template describes the shape of one AsyncAPI object so a form can render every property as a labelled field:
// the user fills values and never types a property name. The first block below is the contract the UI work packages
// import; the optional members at the end of `FieldTemplate` are additive hints (a consumer may ignore all of them).

export type FieldKind =
  | "text" | "markdown" | "url" | "email" | "enum" | "boolean" | "integer" | "stringList" | "keyValue" | "json"
  | "object" | "list" | "tags" | "reference" | "entityPin";

/** What a `reference` field points at (the UI offers the matching parts of the document). */
export type ReferenceTarget = "server" | "channel" | "message" | "securityScheme" | "messageTrait" | "operationTrait";

export interface FieldTemplate {
  /** The AsyncAPI property name, e.g. "protocolVersion". */
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** Plain-language explanation, reworded from the spec description. */
  help?: string;
  placeholder?: string;
  example?: string;
  /** kind "enum". */
  options?: Array<{ value: string; label: string; help?: string }>;
  /** Free text with known values (protocols, content types, ...). Also lists the allowed items of a `stringList`. */
  suggestions?: string[];
  /** kind "object" | "list" (the item shape) | "tags" (the shape of one tag, for per-tag details). */
  fields?: FieldTemplate[];
  /** basics = required + common (shown open); more = the rest (still shown, collapsed by default). */
  group: "basics" | "more";

  // --- Additive, optional hints. ---
  /** Default the spec applies when the property is omitted (binding templates carry it from the binding schema). */
  default?: string | number | boolean;
  /** kind "reference": the part of the document the value points at. */
  refersTo?: ReferenceTarget;
  /** kind "reference": a list of references (true) or exactly one (absent/false). */
  multiple?: boolean;
  /** kind "list": the items are stored as a map keyed by a name the user chooses (server variables, channel parameters). */
  mapKeyLabel?: string;
  /** Show the field only while the sibling field `field` holds one of `oneOf` (security scheme type-specific properties). */
  when?: { field: string; oneOf: string[] };
}

export type ObjectTemplateId =
  | "info" | "contact" | "license" | "externalDocs" | "tag" | "server" | "serverVariable" | "channel" | "channelParameter"
  | "operation" | "operationReply" | "operationReplyAddress" | "operationTrait" | "message" | "messageTrait" | "messageExample"
  | "correlationId" | "securityScheme";

export type BindingTarget = "server" | "channel" | "operation" | "message";
/** `binding:<protocol>:<target>`, the id of a template returned by `bindingTemplate`. */
export type BindingTemplateId = `binding:${string}:${BindingTarget}`;

export interface ObjectTemplate {
  id: ObjectTemplateId | BindingTemplateId;
  label: string;
  fields: FieldTemplate[];
}
