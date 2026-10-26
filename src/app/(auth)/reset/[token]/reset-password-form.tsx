"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InvalidLinkCard } from "../../_components/invalid-link";
import { NewPasswordFields } from "../../_components/new-password-fields";
import type { TokenFormState } from "../../_components/token-form-state";
import { consumeResetAction } from "./actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState<TokenFormState | undefined, FormData>(consumeResetAction, undefined);

  // The link died while the form was open (used elsewhere, expired, or the address is locked): the same card as for any dead link.
  if (state?.invalid) return <InvalidLinkCard />;

  return (
    <div className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <div className="mb-space-6">
        <h1 className="text-display text-foreground">Choose a new password</h1>
        <p className="text-body text-muted-foreground mt-space-1">You will sign in with it afterwards.</p>
      </div>

      {state?.error && (
        <div role="alert" data-testid="reset-error" className="bg-destructive/10 text-destructive text-body-small p-space-3 rounded-lg mb-space-4 border border-destructive/20">
          {state.error}
        </div>
      )}

      <form action={formAction} data-testid="reset-form" className="space-y-space-4">
        <input type="hidden" name="token" value={token} />
        <NewPasswordFields idPrefix="reset" errors={state?.fieldErrors} />
        <Button type="submit" className="w-full h-10" disabled={isPending} data-testid="reset-submit">
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Set password"
          )}
        </Button>
      </form>
    </div>
  );
}
