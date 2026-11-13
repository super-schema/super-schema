"use client";
import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";

export function AttributeControl({
  label,
  hint,
  help,
  error,
  children,
  group = false,
  labelHidden = false,
}: {
  group?: boolean;
  label: string;
  /** Keep the label for assistive technology only (the host shows it already). */
  labelHidden?: boolean;
  /** Small monospace note after the label, for example the TypeSpec decorator a control writes. */
  hint?: string;
  help?: ReactNode;
  error?: string;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  return (
    <Field data-invalid={Boolean(error) || undefined}>
      <FieldLabel id={`${id}-label`} htmlFor={group ? undefined : id} className={labelHidden ? "sr-only" : undefined}>
        {label}
        {hint && (
          <code className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            {hint}
          </code>
        )}
      </FieldLabel>
      {group ? (
        <div role="group" aria-labelledby={`${id}-label`}>
          {children}
        </div>
      ) : (
        cloneElement(children, {
          id,
          "aria-label": children.props["aria-label"] ?? label,
          "aria-invalid": Boolean(error) || undefined,
          "aria-describedby": error
            ? `${id}-error`
            : help
              ? `${id}-help`
              : undefined,
        })
      )}
      {help && <FieldDescription id={`${id}-help`}>{help}</FieldDescription>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
export const SELECT_CLASS =
  "min-h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
