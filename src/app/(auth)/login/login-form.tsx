"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { INVALID_CREDENTIALS_MESSAGE, LOGIN_NOTICES, isLoginNoticeKey } from "@/lib/auth/messages";

/**
 * Where to go after signing in: the `callbackUrl` the middleware put on the address, when it is a path of this site (`safeCallbackUrl`),
 * else the dashboard. Read from the address when the form is sent, not while rendering: `useSearchParams` would
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

/** The notice the address asks for (`/login?notice=reset`), when it is one of the fixed few: nothing in the address is ever shown as typed. */
function noticeFromAddress(): string | null {
  const asked = new URLSearchParams(window.location.search).getAll("notice");
  return asked.length === 1 && isLoginNoticeKey(asked[0]) ? LOGIN_NOTICES[asked[0]] : null;
}

/** The notice for this address in the browser; none in the server's HTML and while the page hydrates (the address is read when the page runs here). */
function useNotice(): string | null {
  return useSyncExternalStore(subscribeNever, noticeFromAddress, () => null);
}

/**
 * @param registrationOpen the server's answer to "may anyone register?" (`AUTH_REGISTRATION=open`): the "Create one" link is shown only then
 */
export function LoginForm({ registrationOpen = false }: { registrationOpen?: boolean }) {
  const router = useRouter();
  const notice = useNotice();
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
      // One message for every reason: an unknown e-mail, a wrong password, a disabled account, a locked e-mail or address.
      setError(INVALID_CREDENTIALS_MESSAGE);
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

      {/* Notice after a redirect (registered, password changed, invited): fixed texts only */}
      {notice && (
        <div role="status" data-testid="login-notice" className="bg-muted text-foreground text-body-small p-space-3 rounded-lg mb-space-4 border border-border">
          {notice}
        </div>
      )}

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

      {registrationOpen && (
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
      )}
    </div>
  );
}
