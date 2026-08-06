"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { resendVerificationAction } from "@/lib/auth/actions";
import { IDLE_AUTH_STATE } from "@/lib/auth/form-state";

import { FormField, FormMessage } from "./form-field";

/**
 * "Didn't get the confirmation email?"
 *
 * Rendered unconditionally on the sign-in page rather than only when we know
 * the account is unconfirmed — because we deliberately do not know. GoTrue's
 * `email_not_confirmed` is folded into `invalid_credentials` (see
 * `map-error.ts`) so the form can't be used to test whether an address is
 * registered, and the cost of that is a user who forgot to click the link
 * getting unhelpful copy. This is what pays that cost back: the way out is
 * always visible, without anyone having to be told they need it.
 *
 * Collapsed by default so it doesn't compete with the sign-in form.
 */
export function ResendVerificationForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(
    resendVerificationAction,
    IDLE_AUTH_STATE,
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-body-sm text-fg-subtle hover:text-fg underline"
      >
        Didn&rsquo;t get the confirmation email?
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      {state.status === "error" && state.message && (
        <FormMessage status="error">{state.message}</FormMessage>
      )}
      {state.status === "success" && state.message && (
        <FormMessage status="success">{state.message}</FormMessage>
      )}

      <FormField
        label="Resend confirmation to"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.fieldErrors.email}
      />

      <Button type="submit" variant="secondary" size="sm" isLoading={pending}>
        Resend
      </Button>
    </form>
  );
}
