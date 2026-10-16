"use client";

// src/features/events/builder/template/FieldControl.tsx
// One template field: the frame (label or legend, required marker, help text, inline errors, ids) around the control for its kind,
// and `FieldGroups`, which lays a list of fields out as "basics" plus a collapsible "More properties (N set)" group. The two are
// mutually recursive (an object or list item renders `FieldGroups` again), so they live in one module.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { FieldTemplate } from "@/lib/events/templates";
import { BooleanControl } from "./controls/BooleanControl";
import { ChipsControl } from "./controls/ChipsControl";
import { EntityPinControl } from "./controls/EntityPinControl";
import { EnumControl } from "./controls/EnumControl";
import { IntegerControl } from "./controls/IntegerControl";
import { JsonControl } from "./controls/JsonControl";
import { KeyValueControl } from "./controls/KeyValueControl";
import { ListControl } from "./controls/ListControl";
import { MarkdownControl } from "./controls/MarkdownControl";
import { ObjectControl } from "./controls/ObjectControl";
import { ReferenceControl } from "./controls/ReferenceControl";
import { TextControl } from "./controls/TextControl";
import type { ControlProps, FormEnv, NestedFormArgs } from "./controls/types";
import { InfoTip } from "./InfoTip";
import { errorsFor, isFieldSet, omitKey, setField, whenMatches } from "./value";

type Frame = "label" | "group" | "pin";

/** How a field is framed: a label for one control, a fieldset around several, or the entity picker's own legend. */
function frameOf(field: FieldTemplate): Frame {
  switch (field.kind) {
    case "object": case "list": case "keyValue": return "group";
    case "reference": return field.multiple ? "group" : "label";
    case "entityPin": return "pin";
    default: return "label";
  }
}

const TAG_DEEP = /^\/\d+(\/name)?$/;

/** The messages shown on the field itself: leaf controls show everything below their pointer, containers only their own. */
function ownErrors(field: FieldTemplate, errors: FormEnv["errors"], path: string): string[] {
  switch (field.kind) {
    case "object": case "list":
      return errorsFor(errors, path, { exact: true });
    case "tags":
      return field.fields
        ? (errors ?? []).filter((e) => e.pointer === path || (e.pointer.startsWith(path) && TAG_DEEP.test(e.pointer.slice(path.length)))).map((e) => e.message)
        : errorsFor(errors, path);
    default:
      return errorsFor(errors, path);
  }
}

function control(field: FieldTemplate, props: ControlProps): ReactNode {
  switch (field.kind) {
    case "text": case "url": case "email": return <TextControl {...props} />;
    case "markdown": return <MarkdownControl {...props} />;
    case "enum": return <EnumControl {...props} />;
    case "boolean": return <BooleanControl {...props} />;
    case "integer": return <IntegerControl {...props} />;
    case "stringList": case "tags": return <ChipsControl {...props} />;
    case "keyValue": return <KeyValueControl {...props} />;
    case "json": return <JsonControl {...props} />;
    case "object": return <ObjectControl {...props} />;
    case "list": return <ListControl {...props} />;
    case "reference": return <ReferenceControl {...props} />;
    case "entityPin": return <EntityPinControl {...props} />;
    default:
      return <p data-testid={`${props.id}-unsupported`} className="text-caption text-muted-foreground">This property cannot be edited here.</p>;
  }
}

export interface FieldControlProps {
  field: FieldTemplate;
  value: unknown;
  /** The next value; it may be empty, the caller removes the key. */
  onChange: (next: unknown) => void;
  idPrefix: string;
  /** The JSON pointer of the object this field is a property of ("" at the top). */
  errorPrefix: string;
  env: FormEnv;
}

export function FieldControl({ field, value, onChange, idPrefix, errorPrefix, env }: FieldControlProps) {
  const id = `${idPrefix}-${field.key}`;
  const path = `${errorPrefix}/${field.key}`;
  const required = Boolean(field.required);
  const frame = frameOf(field);
  const messages = ownErrors(field, env.errors, path);
  const errorId = messages.length > 0 ? `${id}-error` : undefined;
  const hintId = field.help ? `${id}-hint` : undefined;
  const noteId = required && frame !== "label" ? `${id}-required-note` : undefined;
  const describedBy = [errorId, hintId, noteId].filter(Boolean).join(" ") || undefined;
  const placeholder = field.placeholder ?? (field.example ? `e.g. ${field.example}` : undefined);

  const props: ControlProps = {
    field, id, value, onChange, disabled: env.disabled, required, invalid: messages.length > 0, describedBy, placeholder, path,
    errors: env.errors, context: env.context,
    renderFields: (args: NestedFormArgs) => (
      <FieldGroups {...args} env={args.defaultOpenMore ? { ...env, defaultOpenMore: true } : env} />
    ),
  };

  // Compact help: an optional field's help sits behind an info button next to its label; a required field's help stays under it. The
  // tip keeps the `${id}-hint` id, so the control's aria-describedby and the button's both point at the same text.
  const compact = Boolean(env.compactHelp) && !required && Boolean(field.help) && frame !== "pin";
  const tip = compact ? <InfoTip id={`${id}-hint`} label={`About ${field.label}`}>{field.help}</InfoTip> : null;
  const help = field.help && !compact && <p id={hintId} data-testid={hintId} className="text-caption text-muted-foreground">{field.help}</p>;
  const error = errorId && <p id={errorId} data-testid={errorId} className="text-body-small text-destructive">{messages.join(" ")}</p>;

  if (frame === "group") {
    return (
      <fieldset data-testid={id} aria-describedby={describedBy} className="space-y-space-3 rounded-md border border-border p-space-3">
        <legend className="px-space-1 text-caption text-muted-foreground">
          {field.label}
          {required && <span aria-hidden="true" data-testid={`${id}-required`} className="ml-space-1 text-destructive">*</span>}
          {tip && <span className="ml-space-1 inline-flex align-middle">{tip}</span>}
        </legend>
        {required && <span id={noteId} data-testid={noteId} className="sr-only">Required</span>}
        {help}
        {control(field, props)}
        {error}
      </fieldset>
    );
  }

  if (frame === "pin") {
    return (
      <div className="space-y-space-1" data-testid={`${id}-field`}>
        {control(field, props)}
        {required && <p id={noteId} data-testid={noteId} className="text-caption text-muted-foreground">Required</p>}
        {help}
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-space-1" data-testid={`${id}-field`}>
      <div className="flex items-baseline gap-space-1">
        <label htmlFor={id} className="block text-caption text-muted-foreground">{field.label}</label>
        {required && <span aria-hidden="true" data-testid={`${id}-required`} className="text-caption text-destructive">*</span>}
        {tip}
      </div>
      {control(field, props)}
      {help}
      {error}
    </div>
  );
}

export interface FieldGroupsProps extends NestedFormArgs {
  env: FormEnv;
}

/**
 * The fields of one object: those whose `when` holds, basics first and open, the rest in a "More properties (N set)" group that is
 * collapsed unless something in it is set, has a problem, or the form asks for it open. Properties of the value the template does not
 * know are passed through untouched and named in a read-only line.
 */
export function FieldGroups({ fields, value, onChange, idPrefix, errorPrefix, env, hideKeys }: FieldGroupsProps) {
  const hidden = hideKeys ?? [];
  const visible = fields.filter((f) => !hidden.includes(f.key) && whenMatches(f, value));
  const basics = visible.filter((f) => f.group === "basics");
  const more = visible.filter((f) => f.group === "more");
  const setCount = more.filter((f) => isFieldSet(f, value)).length;
  const hasProblem = more.some((f) => errorsFor(env.errors, `${errorPrefix}/${f.key}`).length > 0);
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const open = userOpen ?? (basics.length === 0 || setCount > 0 || hasProblem || Boolean(env.defaultOpenMore));

  function change(field: FieldTemplate, next: unknown) {
    const map = field.kind === "keyValue" || (field.kind === "list" && Boolean(field.mapKeyLabel));
    let updated = setField(value, field.key, next, { keepEmptyEntries: map });
    // A field that only applies to another value of its controlling sibling goes away with it, so the output stays valid.
    for (const dependent of fields) {
      if (dependent.when?.field === field.key && !whenMatches(dependent, updated)) updated = omitKey(updated, dependent.key);
    }
    onChange(updated);
  }

  const render = (field: FieldTemplate) => (
    <FieldControl
      key={field.key} field={field} value={value[field.key]} onChange={(next) => change(field, next)}
      idPrefix={idPrefix} errorPrefix={errorPrefix} env={env}
    />
  );

  const known = new Set([...fields.map((f) => f.key), ...hidden]);
  const others = Object.keys(value).filter((k) => !known.has(k));
  const moreId = `${idPrefix}-more`;
  const toggleId = `${idPrefix}-more-toggle`;

  return (
    <div className="space-y-space-4">
      {basics.map(render)}
      {more.length > 0 && (
        <div className="space-y-space-3">
          <button
            type="button" id={toggleId} data-testid={toggleId} aria-expanded={open} aria-controls={moreId} onClick={() => setUserOpen(!open)}
            className="inline-flex items-center gap-space-1 rounded-md text-body-small font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {open ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
            {`More properties (${setCount} set)`}
          </button>
          {open && (
            <div id={moreId} data-testid={moreId} role="group" aria-labelledby={toggleId} className="space-y-space-4 border-l-2 border-border pl-space-3">
              {more.map(render)}
            </div>
          )}
        </div>
      )}
      {others.length > 0 && (
        <p data-testid={`${idPrefix}-other`} className="text-caption text-muted-foreground">
          {`Other properties (kept as they are): ${others.join(", ")}`}
        </p>
      )}
    </div>
  );
}
