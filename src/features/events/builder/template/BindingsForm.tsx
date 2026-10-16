"use client";

// src/features/events/builder/template/BindingsForm.tsx
// Protocol bindings (AsyncAPI `bindings`: `{ [protocol]: { …fields, bindingVersion } }`) for a server, channel, operation or message.
// A protocol with a template (src/lib/events/templates/bindings) is a TemplateForm; several protocols can be set at once. The
// binding version is set automatically, and a protocol whose fields are all empty is dropped from the value. A protocol the
// catalog does not know (or has no binding for this target) falls back to a note and, when it has content, a JSON editor.
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BINDING_PROTOCOLS, bindingProtocolLabel, bindingTemplate, bindingVersion, type BindingTarget, type FieldTemplate } from "@/lib/events/templates";
import { selectClass } from "../controls";
import type { FormEnv, FormProblem } from "./controls/types";
import { FieldControl } from "./FieldControl";
import { TemplateForm } from "./TemplateForm";
import { errorsFor, isEmptyValue, omitKey } from "./value";

const OTHER = "__other__";
const PROTOCOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_PROBLEM = "Use letters, digits, dots, dashes and underscores, starting with a letter or digit.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const JSON_FIELD: FieldTemplate = { key: "json", label: "Settings (JSON)", kind: "json", group: "basics" };

export interface BindingsFormProps {
  target: BindingTarget;
  /** `{ [protocol]: { …bindingFields, bindingVersion } }`. */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  idPrefix: string;
  /** Preselected in the protocol select while no binding is set yet (for example the protocol of the server). */
  suggestedProtocol?: string;
  errors?: Array<FormProblem>;
  /** The pointer of the bindings object; a field's problems are at `${errorPrefix}/${protocol}/${key}`. */
  errorPrefix?: string;
  disabled?: boolean;
}

export function BindingsForm({ target, value, onChange, idPrefix, suggestedProtocol, errors, errorPrefix = "", disabled }: BindingsFormProps) {
  const bindings = isRecord(value) ? value : {};
  const present = Object.keys(bindings);
  // Protocols added or edited here stay on screen while their fields are empty (an empty protocol is not in the value).
  const [pending, setPending] = useState<string[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const shown = [...present, ...pending.filter((p) => !present.includes(p))];

  const suggested = suggestedProtocol && BINDING_PROTOCOLS.includes(suggestedProtocol) ? suggestedProtocol : "";
  const selected = choice ?? (shown.length === 0 ? suggested : "");
  const customName = custom.trim();
  const customProblem = selected !== OTHER || customName === "" ? null : !PROTOCOL_NAME.test(customName) ? NAME_PROBLEM : shown.includes(customName) ? "This protocol is already added." : null;
  const canAdd = selected === OTHER ? customName !== "" && customProblem === null : selected !== "";
  const env: FormEnv = { errors, disabled };

  function addProtocol() {
    const protocol = selected === OTHER ? customName : selected;
    setPending((prev) => (prev.includes(protocol) ? prev : [...prev, protocol]));
    setChoice("");
    setCustom("");
  }
  function setEntry(protocol: string, next: unknown, version: string | null) {
    setPending((prev) => (prev.includes(protocol) ? prev : [...prev, protocol]));
    const fields = isRecord(next) ? next : {};
    onChange(isEmptyValue(fields) ? omitKey(bindings, protocol) : { ...bindings, [protocol]: version ? { ...fields, bindingVersion: version } : fields });
  }
  function removeProtocol(protocol: string) {
    setPending((prev) => prev.filter((p) => p !== protocol));
    if (Object.hasOwn(bindings, protocol)) onChange(omitKey(bindings, protocol));
  }

  return (
    <fieldset data-testid={idPrefix} className="space-y-space-4">
      <legend className="text-caption text-muted-foreground">Protocol bindings</legend>
      {shown.map((protocol) => {
        const template = bindingTemplate(protocol, target);
        const version = bindingVersion(protocol, target);
        const known = BINDING_PROTOCOLS.includes(protocol);
        const label = known ? bindingProtocolLabel(protocol) : protocol;
        const entry = isRecord(bindings[protocol]) ? bindings[protocol] as Record<string, unknown> : {};
        const entryId = `${idPrefix}-${protocol}`;
        const entryErrors = errorsFor(errors, `${errorPrefix}/${protocol}`, { exact: true });
        return (
          <fieldset
            key={protocol} data-testid={entryId} aria-describedby={entryErrors.length ? `${entryId}-error` : undefined}
            className="space-y-space-3 rounded-md border border-border p-space-3"
          >
            <legend className="px-space-1 text-caption text-muted-foreground">{`${label} binding`}</legend>
            <div className="flex justify-end">
              <Button
                type="button" variant="ghost" size="sm" aria-label={`Remove ${label} binding`} data-testid={`${entryId}-remove`}
                disabled={disabled} onClick={() => removeProtocol(protocol)}
              >
                <Trash2 aria-hidden="true" />
                Remove
              </Button>
            </div>
            {entryErrors.length > 0 && <p id={`${entryId}-error`} data-testid={`${entryId}-error`} className="text-body-small text-destructive">{entryErrors.join(" ")}</p>}
            {template ? (
              <TemplateForm
                template={template} value={omitKey(entry, "bindingVersion")} onChange={(next) => setEntry(protocol, next, version)} idPrefix={entryId}
                errors={errors} errorPrefix={`${errorPrefix}/${protocol}`} disabled={disabled}
              />
            ) : (
              <>
                <p data-testid={`${entryId}-none`} className="text-body-small text-muted-foreground">
                  {known ? `No ${target} binding for ${label}.` : `No template for ${protocol}. Edit its settings as JSON.`}
                </p>
                {(!known || !isEmptyValue(entry)) && (
                  <FieldControl
                    field={{ ...JSON_FIELD, label: `${label} settings (JSON)` }} value={isEmptyValue(entry) ? undefined : entry}
                    onChange={(next) => setEntry(protocol, next, null)} idPrefix={entryId} errorPrefix={`${errorPrefix}/${protocol}`} env={env}
                  />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-end gap-space-2">
        <div className="space-y-space-1">
          <label htmlFor={`${idPrefix}-protocol`} className="block text-caption text-muted-foreground">Protocol</label>
          <select
            id={`${idPrefix}-protocol`} data-testid={`${idPrefix}-protocol`} className={selectClass} value={selected} disabled={disabled}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">Select a protocol…</option>
            {BINDING_PROTOCOLS.filter((p) => !shown.includes(p)).map((p) => (
              <option key={p} value={p}>{bindingTemplate(p, target) ? bindingProtocolLabel(p) : `${bindingProtocolLabel(p)} (no ${target} binding)`}</option>
            ))}
            <option value={OTHER}>Other protocol…</option>
          </select>
        </div>
        {selected === OTHER && (
          <div className="space-y-space-1">
            <label htmlFor={`${idPrefix}-custom-protocol`} className="block text-caption text-muted-foreground">Protocol name</label>
            <Input
              id={`${idPrefix}-custom-protocol`} data-testid={`${idPrefix}-custom-protocol`} value={custom} disabled={disabled} autoComplete="off" spellCheck={false}
              aria-invalid={customProblem ? true : undefined} aria-describedby={customProblem ? `${idPrefix}-custom-protocol-validation` : undefined}
              onChange={(e) => setCustom(e.target.value)}
            />
            {customProblem && (
              <p id={`${idPrefix}-custom-protocol-validation`} data-testid={`${idPrefix}-custom-protocol-validation`} className="text-body-small text-destructive">
                {customProblem}
              </p>
            )}
          </div>
        )}
        <Button type="button" variant="outline" size="sm" data-testid={`${idPrefix}-add`} disabled={disabled || !canAdd} onClick={addProtocol}>
          <Plus aria-hidden="true" />
          Add binding
        </Button>
      </div>
    </fieldset>
  );
}
