"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

/**
 * "Continue with Google" and the divider under it, for the login and register pages. The pages render this ONLY when the server says Google sign-in is
 * configured (`googleSignInEnabled`, src/lib/auth/providers.ts); the button is never there for a provider that is not.
 *
 * @param getCallbackUrl where Google sends the user afterwards, asked when the button is pressed (the login page reads it from the address then)
 */
export function GoogleSignIn({ getCallbackUrl }: { getCallbackUrl: () => string }) {
  return (
    <>
      <div className="space-y-space-2 mb-space-6">
        <Button variant="outline" className="w-full gap-2 h-10" onClick={() => signIn("google", { callbackUrl: getCallbackUrl() })}>
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
