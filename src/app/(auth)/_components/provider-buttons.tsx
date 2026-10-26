"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * One button for each identity provider the SERVER has enabled (`AUTH_PROVIDERS`, src/lib/auth/providers.ts: none by default, and then this renders
 * nothing at all), with the divider under them. The label is the provider's (`AUTH_PROVIDER_<KEY>_LABEL`, else its name). A button starts the sign-in
 * server action for ITS provider id (`signInWithProvider`, src/app/(auth)/login/provider-actions.ts), which checks the id against the registry
 * again and the destination against `safeCallbackUrl`; who may actually sign in is decided after the provider has answered, so a button promises
 * nothing about the person. The server page hands the action down as a prop (the documented way to give a client component a server action), so the
 * form itself does not import Auth.js.
 *
 * @param providers the server's list (id and button text)
 * @param signInWithProvider the server action a button starts
 * @param getCallbackUrl where to go afterwards, asked when a button is pressed (the login page reads it from the address then)
 * @param disabled true until the page is interactive (a click before hydration would do nothing)
 */
export function ProviderButtons({
  providers,
  signInWithProvider,
  getCallbackUrl,
  disabled = false,
}: {
  providers: ReadonlyArray<{ id: string; label: string }>;
  signInWithProvider: (providerId: string, callbackUrl: string) => Promise<void>;
  getCallbackUrl: () => string;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  if (providers.length === 0) return null;

  return (
    <>
      <div className="space-y-space-2 mb-space-6" data-testid="provider-buttons">
        {providers.map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            className="w-full gap-2 h-10"
            data-testid={`provider-button-${id}`}
            disabled={disabled || pending}
            onClick={() => startTransition(() => signInWithProvider(id, getCallbackUrl()))}
          >
            {pending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
            {label}
          </Button>
        ))}
      </div>

      <div className="relative mb-space-6">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-background px-space-3 text-caption text-muted-foreground uppercase tracking-wider">or continue with email</span>
        </div>
      </div>
    </>
  );
}
