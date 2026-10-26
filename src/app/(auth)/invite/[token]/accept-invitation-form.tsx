"use client";

import { useActionState, useId } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InvalidLinkCard } from "../../_components/invalid-link";
import { NewPasswordFields } from "../../_components/new-password-fields";
import type { TokenFormState } from "../../_components/token-form-state";
import { acceptInvitationAction } from "./actions";

export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, isPending] = useActionState<TokenFormState | undefined, FormData>(acceptInvitationAction, undefined);
  const emailId = useId();
  const nameId = useId();

  // The link died while the form was open (used elsewhere, expired, or the address is locked): the same card as for any dead link.
  if (state?.invalid) return <InvalidLinkCard />;

  return (
    <div className="surface-glass rounded-xl border border-border p-space-8 w-full">
      <div className="mb-space-6">
        <h1 className="text-display text-foreground">Accept your invitation</h1>
        <p className="text-body text-muted-foreground mt-space-1">Choose a password to finish making your account.</p>
      </div>

      {state?.error && (
        <div role="alert" data-testid="invite-error" className="bg-destructive/10 text-destructive text-body-small p-space-3 rounded-lg mb-space-4 border border-destructive/20">
          {state.error}
        </div>
      )}

      <form action={formAction} data-testid="invite-form" className="space-y-space-4">
        <input type="hidden" name="token" value={token} />
        <div>
          <label htmlFor={emailId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Email
          </label>
          {/* The account is bound to the invited address: shown, not editable, and not read from the form. */}
          <Input id={emailId} type="email" value={email} readOnly className="h-10" data-testid="invite-email" />
        </div>
        <div>
          <label htmlFor={nameId} className="text-body-small text-foreground mb-space-1 block font-medium">
            Name <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input id={nameId} name="name" type="text" autoComplete="name" maxLength={120} className="h-10" data-testid="invite-name" />
        </div>
        <NewPasswordFields idPrefix="invite" errors={state?.fieldErrors} />
        <Button type="submit" className="w-full h-10" disabled={isPending} data-testid="invite-submit">
          {isPending ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating account...
            </>
          ) : (
            "Create account"
          )}
        </Button>
      </form>
    </div>
  );
}
