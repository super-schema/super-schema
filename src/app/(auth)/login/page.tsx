"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { safeCallbackUrl } from "@/lib/safe-callback-url";

/**
 * Where to go after signing in: the `callbackUrl` the middleware put on the address, when it is a path of this site (`safeCallbackUrl`),
 * else the dashboard. Read from the address when the form is sent or Google is chosen, not while rendering: `useSearchParams` would
 * make the page client-rendered behind a Suspense boundary, and the form would no longer be in the server's HTML.
 */
function requestedDestination(): string {
  const asked = new URLSearchParams(window.location.search).getAll("callbackUrl");
  // A repeated parameter is no destination.
  return safeCallbackUrl(asked.length === 1 ? asked[0] : asked);
}

const subscribeNever = () => () => {};

/** False in the server's HTML and while the page hydrates, true once this component runs in the browser. */
function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

export default function LoginPage() {
  const router = useRouter();
  // The submit button stays disabled until React is running this form: a form submitted before that is submitted by the browser itself.
  const hydrated = useHydrated();
  // The e-mail is state of this component (above the re-keyed card below), so a refused login does not empty it: the user mistyped the
  // password, not the address. The password is left to the browser and is cleared with the card.
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();
  const emailRef = useRef<HTMLInputElement>(null);

  // A refusal re-keys the card (that restarts the shake) and so drops the focused element: the focus goes to the e-mail field of the new card.
  useEffect(() => {
    if (shakeKey > 0) emailRef.current?.focus();
  }, [shakeKey]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsPending(true);

    // What the fields hold NOW, not what React heard of: autofill can fill a field without a change event. The state only keeps the
    // address for after a refusal.
    const formData = new FormData(e.currentTarget);
    const typedEmail = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    setEmail(typedEmail);

    const result = await signIn("credentials", {
      email: typedEmail,
      password,
      redirect: false,
    });

    setIsPending(false);

    if (result?.error) {
      setError("Invalid email or password");
      setShakeKey((k) => k + 1);
    } else {
      router.push(requestedDestination());
      router.refresh();
    }
  }

  return (
    <div
      key={shakeKey}
      data-testid="login-card"
      className={`surface-glass rounded-xl border border-border p-space-8 w-full ${error ? "animate-auth-shake" : ""}`}
    >
      {/* Header */}
      <div className="mb-space-6">
        <h1 className="text-display text-foreground">Welcome back</h1>
        <p className="text-body text-muted-foreground mt-space-1">
          Sign in to your account
        </p>
      </div>

      {/* OAuth Providers */}
      <div className="space-y-space-2 mb-space-6">
        <Button
          variant="outline"
          className="w-full gap-2 h-10"
          onClick={() => signIn("google", { callbackUrl: requestedDestination() })}
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

      {/* Error */}
      {error && (
        <div
          id={errorId}
          role="alert"
          data-testid="login-error"
          className="flex items-center gap-2 bg-destructive/10 text-destructive text-body-small p-space-3 rounded-lg mb-space-4 border border-destructive/20"
        >
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 4a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.25a.75.75 0 100-1.5.75.75 0 000 1.5z" />
          </svg>
          {error}
        </div>
      )}

      {/* Form */}
      {/* method="post": credentials must never be put in a query string (a form submitted before hydration is submitted natively). */}
      <form method="post" onSubmit={handleSubmit} data-testid="login-form" className="space-y-space-4">
        <div>
          <label htmlFor={emailId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Email
          </label>
          <Input
            id={emailId}
            ref={emailRef}
            aria-describedby={error ? errorId : undefined}
            name="email"
            type="email"
            placeholder="you@example.com"
            required
            autoComplete="email"
            className="h-10"
            data-testid="login-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor={passwordId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Password
          </label>
          <div className="relative">
            <Input
              id={passwordId}
              aria-describedby={error ? errorId : undefined}
              name="password"
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              className="h-10 pr-10"
              data-testid="login-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              data-testid="login-password-toggle"
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
        </div>

        <Button type="submit" className="w-full h-10" disabled={isPending || !hydrated} data-testid="login-submit">
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Signing in...
            </>
          ) : (
            "Sign In"
          )}
        </Button>
      </form>

      <p className="text-body text-muted-foreground mt-space-6 text-center">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          data-testid="login-register-link"
          className="text-primary hover:text-primary/80 font-medium transition-colors"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
