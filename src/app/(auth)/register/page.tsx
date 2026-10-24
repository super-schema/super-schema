"use client";

import { useActionState, useState, useMemo } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Eye, EyeOff, Check, X } from "lucide-react";
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

export default function RegisterPage() {
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

      {/* OAuth Providers */}
      <div className="space-y-space-2 mb-space-6">
        <Button
          variant="outline"
          className="w-full gap-2 h-10"
          onClick={() => signIn("google", { callbackUrl: "/schemas" })}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </Button>
      </div>

      {/* Divider */}
      <div className="relative mb-space-6">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-space-3 text-caption text-muted-foreground uppercase tracking-wider">
            or continue with email
          </span>
        </div>
      </div>

      {/* General error */}
      {state?.error && (
        <div
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
          <label className="text-body-small text-foreground mb-space-1 block font-medium">
            Email
          </label>
          <Input
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
            <p className="text-caption text-destructive mt-space-1" data-testid="register-email-error">
              {state.fieldErrors.email}
            </p>
          )}
        </div>

        {/* Password */}
        <div>
          <label className="text-body-small text-foreground mb-space-1 block font-medium">
            Password
          </label>
          <div className="relative">
            <Input
              name="password"
              type={showPassword ? "text" : "password"}
              placeholder="Min 8 characters"
              required
              minLength={8}
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
            <p className="text-caption text-destructive mt-space-1" data-testid="register-password-error">
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
                data-testid="register-password-strength"
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
          <label className="text-body-small text-foreground mb-space-1 block font-medium">
            Confirm Password
          </label>
          <div className="relative">
            <Input
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
            <p className="text-caption text-destructive mt-space-1" data-testid="register-confirm-password-error">
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
