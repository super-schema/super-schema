"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { parseOptionalMailbox } from "@/lib/mailbox";
import type { ProductContactErrors, ProductContactField, ProductContactsDraft } from "@/lib/product-contacts";
import { MailboxChipInput } from "./MailboxChipInput";

interface ProductContactFieldsProps {
  value: ProductContactsDraft;
  errors: ProductContactErrors;
  onChange: (next: ProductContactsDraft) => void;
  onErrorsChange: (next: ProductContactErrors) => void;
  disabled?: boolean;
}

const PLACEHOLDER = "Jane Doe <jane@acme.com>";

function withError(errors: ProductContactErrors, field: ProductContactField, message: string | null): ProductContactErrors {
  const next = { ...errors };
  if (message) next[field] = message;
  else delete next[field];
  return next;
}

/**
 * The product's contact inputs: Engineering Lead and Manager (one mailbox each, optionally with the person's name:
 * `Jane Doe <jane@acme.com>`) and the team's email addresses (chips). All optional. Controlled: the parent form owns the draft
 * (`ProductContactsDraft`) and the per-field messages (`ProductContactErrors`), and turns the draft into the submitted
 * contacts with `resolveProductContactsDraft`, so the same rules apply on submit as on blur.
 */
export function ProductContactFields({ value, errors, onChange, onErrorsChange, disabled }: ProductContactFieldsProps) {
  const reactId = useId();

  function singleField(field: "engineeringLead" | "manager", label: string, testId: string) {
    const inputId = `${reactId}-${field}`;
    const errorId = `${inputId}-error`;
    const error = errors[field];
    return (
      <div className="flex-1 min-w-[220px]">
        <label htmlFor={inputId} className="text-body-small text-foreground mb-space-1 block font-medium">
          {label}
        </label>
        <Input
          id={inputId}
          data-testid={`${testId}-input`}
          value={value[field]}
          onChange={(event) => {
            onChange({ ...value, [field]: event.target.value });
            if (error) onErrorsChange(withError(errors, field, null));
          }}
          onBlur={() => {
            const parsed = parseOptionalMailbox(value[field]);
            onErrorsChange(withError(errors, field, parsed.success ? null : parsed.error.message));
          }}
          placeholder={PLACEHOLDER}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-9"
        />
        {error && (
          <p id={errorId} role="alert" data-testid={`${testId}-error`} className="text-body-small text-destructive mt-space-1">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-space-4">
      <div className="flex gap-space-4 flex-wrap">
        {singleField("engineeringLead", "Engineering Lead", "product-engineering-lead")}
        {singleField("manager", "Manager", "product-manager")}
      </div>
      <MailboxChipInput
        label="Team email addresses"
        testId="product-team-emails"
        placeholder="team@acme.com"
        hint="Press Enter or comma to add an address. Paste several at once. A name can come with each: Jane Doe <jane@acme.com>."
        chips={value.teamEmails}
        draft={value.teamDraft}
        error={errors.teamEmails}
        disabled={disabled}
        onChange={({ chips, draft }) => onChange({ ...value, teamEmails: chips, teamDraft: draft })}
        onError={(message) => onErrorsChange(withError(errors, "teamEmails", message))}
      />
    </div>
  );
}
