// src/features/events/builder/template/controls/types.ts
// Types shared by TemplateForm, FieldControl and the controls. Type-only imports: nothing here reaches the server.
import type { ReactNode } from "react";
import type { EntityOption, VersionOption } from "@/features/events/shared/EntityPinPicker";
import type { FieldTemplate } from "@/lib/events/templates";

/** One thing a `reference` field can point at (a server, a message, a security scheme, ...). */
export interface ReferenceOption { value: string; label: string; hint?: string }

/** The loader `EntityPinPicker` takes for the published versions of an entity. */
export type LoadVersions = (entityId: string) => Promise<VersionOption[]>;

/** What the surrounding builder can offer a form: the parts a reference can point at, and the entities a pin can choose. */
export interface TemplateFormContext {
  /** Keyed by `FieldTemplate.refersTo` ("server", "channel", "message", "securityScheme", "messageTrait", "operationTrait"). */
  references?: Record<string, ReferenceOption[]>;
  /** For fields of kind "entityPin". */
  entityOptions?: EntityOption[];
  loadVersions?: LoadVersions;
  /**
   * For the examples of ONE message: the JSON Schema of its payload and of its headers (fully self-contained, draft-07 style), each
   * `null` while it is loading, failed to load, or the message has no such pin. Absent where examples have no message to check
   * against (a trait's examples). The example `payload` / `headers` fields are checked against, and generated from, these
   * (see `example-schema.ts`); nothing else reads them.
   */
  pinSchemas?: { payload?: Record<string, unknown> | null; headers?: Record<string, unknown> | null };
  /**
   * Beside `pinSchemas`: which of those schemas is still on its way (rendering one takes seconds). A `null` schema that is loading is
   * told apart from one that is not coming (no entity chosen, or the load failed): the Generate button says "Loading the schema…"
   * for the first and "Needs a … entity with a schema." for the second.
   */
  pinSchemasLoading?: { payload?: boolean; headers?: boolean };
}

/** A problem to show next to the field it points at: a JSON pointer into the document and the message. */
export interface FormProblem { pointer: string; message: string }

/** What every control of one form shares. */
export interface FormEnv {
  context?: TemplateFormContext;
  errors?: ReadonlyArray<FormProblem>;
  disabled?: boolean;
  defaultOpenMore?: boolean;
  /** Show the help text of an optional field as a small info tooltip instead of a line under it (required fields keep theirs inline). */
  compactHelp?: boolean;
}

/** What a control that contains fields (an object, a list item, a tag's details) asks its form to render. */
export interface NestedFormArgs {
  fields: FieldTemplate[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  idPrefix: string;
  errorPrefix: string;
  hideKeys?: string[];
  /** Open the "More properties" groups from the start (a tag's details are already opened on demand). */
  defaultOpenMore?: boolean;
}
export type RenderFields = (args: NestedFormArgs) => ReactNode;

/** The props every control gets. The surrounding frame (FieldControl) draws the label, help text and errors. */
export interface ControlProps {
  field: FieldTemplate;
  /** Element id and `data-testid` of the control itself. */
  id: string;
  /** The field's value, `undefined` while unset. */
  value: unknown;
  /** The next value; it may be empty (`undefined`, `""`, `[]`, `{}`): the caller removes the key. */
  onChange: (next: unknown) => void;
  disabled?: boolean;
  required: boolean;
  invalid: boolean;
  /** Space-separated ids of the help text and errors, for `aria-describedby`. */
  describedBy?: string;
  placeholder?: string;
  /** The JSON pointer of this field (`${errorPrefix}/${key}`): what the problems of its parts are matched against. */
  path: string;
  /** Every problem of the form, for controls that show the problems of their own items. */
  errors?: ReadonlyArray<FormProblem>;
  /** The surrounding builder's references and entities. */
  context?: TemplateFormContext;
  /**
   * For a "json" field: a JSON Schema its text is checked against (violations are warnings, the value is written all the same). Its
   * `$ref`s must resolve inside the schema (`#`, `#/definitions/X`, `#/$defs/X`); an unresolvable one is silently accepted, so that part
   * of the schema is simply not checked. `null` or `undefined`: no schema, the editor behaves as it always did. See `JsonEditor`.
   */
  schema?: Record<string, unknown> | null;
  /** Renders fields inside this control (objects, list items, a tag's details). */
  renderFields: RenderFields;
}
