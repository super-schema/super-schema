"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES } from "@/lib/auth/password-limits";

/**
 * A new password and its confirmation, for the forms that set one (accepting an invitation, using a reset link). The server checks the policy
 * (`validatePassword`); the fields only say what it is and show what the server answered.
 */
export function NewPasswordFields({ idPrefix, errors }: { idPrefix: string; errors?: { password?: string; confirmPassword?: string } }) {
  const passwordId = useId();
  const confirmId = useId();
  const [show, setShow] = useState(false);

  return (
    <>
      <div>
        <label htmlFor={passwordId} className="text-body-small text-foreground mb-space-1 block font-medium">
          New password
        </label>
        <div className="relative">
          <Input
            id={passwordId}
            name="password"
            type={show ? "text" : "password"}
            required
            minLength={PASSWORD_MIN_BYTES}
            autoComplete="new-password"
            className="h-10 pr-10"
            aria-invalid={!!errors?.password}
            aria-describedby={`${passwordId}-hint${errors?.password ? ` ${passwordId}-error` : ""}`}
            data-testid={`${idPrefix}-password`}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            tabIndex={-1}
          >
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <p id={`${passwordId}-hint`} className="text-caption text-muted-foreground mt-space-1">
          At least {PASSWORD_MIN_BYTES} characters, up to {PASSWORD_MAX_BYTES} bytes. A few words make a good passphrase.
        </p>
        {errors?.password && (
          <p id={`${passwordId}-error`} role="alert" className="text-caption text-destructive mt-space-1" data-testid={`${idPrefix}-password-error`}>
            {errors.password}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={confirmId} className="text-body-small text-foreground mb-space-1 block font-medium">
          Confirm password
        </label>
        <Input
          id={confirmId}
          name="confirmPassword"
          type={show ? "text" : "password"}
          required
          autoComplete="new-password"
          className="h-10"
          aria-invalid={!!errors?.confirmPassword}
          aria-describedby={errors?.confirmPassword ? `${confirmId}-error` : undefined}
          data-testid={`${idPrefix}-confirm-password`}
        />
        {errors?.confirmPassword && (
          <p id={`${confirmId}-error`} role="alert" className="text-caption text-destructive mt-space-1" data-testid={`${idPrefix}-confirm-password-error`}>
            {errors.confirmPassword}
          </p>
        )}
      </div>
    </>
  );
}
