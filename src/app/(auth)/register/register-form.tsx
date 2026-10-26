"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";
import { PASSWORD_MIN_BYTES } from "@/lib/auth/password-limits";
import { registerAction, type RegisterState } from "./actions";

function getPasswordStrength(password: string) {
  if (!password) return { score: 0, label: "" };
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const labels = ["", "Weak", "Fair", "Good", "Strong", "Very strong"];
  const colors = [
    "",
    "bg-destructive",
    "bg-warning",
    "bg-warning",
    "bg-success",
    "bg-success",
  ];
  return { score, label: labels[score], color: colors[score] };
}

/**
 * The registration form of `AUTH_REGISTRATION=open` (the page, `page.tsx`, decides which modes get it).
 */
export function RegisterForm() {
  const [state, formAction, isPending] = useActionState<
    RegisterState | undefined,
    FormData
  >(registerAction, undefined);
  // Controlled, like the passwords: React resets a `<form action>` once its action has answered, which would empty an uncontrolled
  // e-mail field after every refusal (the user has to fix the password, not retype the address).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const emailId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // After the server refused the form the focus goes to the first field with an error (the e-mail for a general failure).
  useEffect(() => {
    if (!state) return;
    if (state.error || state.fieldErrors?.email) emailRef.current?.focus();
    else if (state.fieldErrors?.password) passwordRef.current?.focus();
    else if (state.fieldErrors?.confirmPassword) confirmRef.current?.focus();
  }, [state]);

  const strength = useMemo(() => getPasswordStrength(password), [password]);
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;

  return (
    <div className="surface-glass rounded-xl border border-border p-space-8 w-full">
      {/* Header */}
      <div className="mb-space-6">
        <h1 className="text-display text-foreground">Create account</h1>
        <p className="text-body text-muted-foreground mt-space-1">
          Get started with Super Schema
        </p>
      </div>

      {/* General error */}
      {state?.error && (
        <div
          role="alert"
          data-testid="register-error"
          className="flex items-center gap-2 bg-destructive/10 text-destructive text-body-small p-space-3 rounded-lg mb-space-4 border border-destructive/20"
        >
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.25a.75.75 0 100-1.5.75.75 0 000 1.5z" />
          </svg>
          {state.error}
        </div>
      )}

      {/* Form */}
      <form
        action={formAction}
        data-testid="register-form"
        className="space-y-space-4"
        // The address the field holds when the form is sent (autofill fills a field without a change event), kept for after a refusal.
        onSubmit={(event) => setEmail(String(new FormData(event.currentTarget).get("email") ?? ""))}
      >
        {/* Email */}
        <div>
          <label htmlFor={emailId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Email
          </label>
          <Input
            id={emailId}
            ref={emailRef}
            aria-describedby={state?.fieldErrors?.email ? `${emailId}-error` : undefined}
            name="email"
            type="email"
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="h-10"
            aria-invalid={!!state?.fieldErrors?.email}
            data-testid="register-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {state?.fieldErrors?.email && (
            <p id={`${emailId}-error`} className="text-caption text-destructive mt-space-1" data-testid="register-email-error">
              {state.fieldErrors.email}
            </p>
          )}
        </div>

        {/* Password */}
        <div>
          <label htmlFor={passwordId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Password
          </label>
          <div className="relative">
            <Input
              id={passwordId}
              ref={passwordRef}
              aria-describedby={state?.fieldErrors?.password ? `${passwordId}-error` : undefined}
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder={`At least ${PASSWORD_MIN_BYTES} characters`}
              required
              minLength={PASSWORD_MIN_BYTES}
              autoComplete="new-password"
              className="h-10 pr-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!state?.fieldErrors?.password}
              data-testid="register-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              data-testid="register-password-toggle"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
          {state?.fieldErrors?.password && (
            <p id={`${passwordId}-error`} className="text-caption text-destructive mt-space-1" data-testid="register-password-error">
              {state.fieldErrors.password}
            </p>
          )}

          {/* Password strength indicator */}
          {password.length > 0 && (
            <div className="mt-space-2">
              <div className="flex gap-1 h-1">
                {[1, 2, 3, 4, 5].map((level) => (
                  <div
                    key={level}
                    className={`h-full flex-1 rounded-full transition-all duration-300 ${
                      level <= strength.score
                        ? strength.color
                        : "bg-muted"
                    }`}
                  />
                ))}
              </div>
              <p
                className={`text-caption mt-space-1 ${
                  strength.score <= 1
                    ? "text-destructive"
                    : strength.score <= 3
                      ? "text-warning"
                      : "text-success"
                }`}
              >
                {strength.label}
              </p>
            </div>
          )}
        </div>

        {/* Confirm Password */}
        <div>
          <label htmlFor={confirmId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Confirm Password
          </label>
          <div className="relative">
            <Input
              id={confirmId}
              ref={confirmRef}
              aria-describedby={state?.fieldErrors?.confirmPassword ? `${confirmId}-error` : undefined}
              name="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              placeholder="Confirm password"
              required
              autoComplete="new-password"
              className={`h-10 pr-10 ${
                passwordsMatch
                  ? "border-success focus-visible:border-success focus-visible:ring-success/50"
                  : passwordsMismatch
                    ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/50"
                    : ""
              }`}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-invalid={passwordsMismatch || !!state?.fieldErrors?.confirmPassword}
              data-testid="register-confirm-password"
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}
              data-testid="register-confirm-password-toggle"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              tabIndex={-1}
            >
              {showConfirmPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
          {/* Real-time match feedback */}
          {confirmPassword.length > 0 && (
            <div className="flex items-center gap-1 mt-space-1">
              {passwordsMatch ? (
                <>
                  <Check className="w-3 h-3 text-success" />
                  <span className="text-caption text-success">
                    Passwords match
                  </span>
                </>
              ) : (
                <>
                  <X className="w-3 h-3 text-destructive" />
                  <span className="text-caption text-destructive">
                    Passwords do not match
                  </span>
                </>
              )}
            </div>
          )}
          {state?.fieldErrors?.confirmPassword && (
            <p id={`${confirmId}-error`} className="text-caption text-destructive mt-space-1" data-testid="register-confirm-password-error">
              {state.fieldErrors.confirmPassword}
            </p>
          )}
        </div>

        <Button type="submit" className="w-full h-10" disabled={isPending} data-testid="register-submit">
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating account...
            </>
          ) : (
            "Create Account"
          )}
        </Button>
      </form>

      <p className="text-body text-muted-foreground mt-space-6 text-center">
        Already have an account?{" "}
        <Link
          href="/login"
          data-testid="register-login-link"
          className="text-primary hover:text-primary/80 font-medium transition-colors"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
