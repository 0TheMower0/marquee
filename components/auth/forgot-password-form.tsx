"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { requestPasswordResetAction } from "@/lib/auth/actions";
import { IDLE_AUTH_STATE } from "@/lib/auth/form-state";

import { FormField, FormMessage } from "./form-field";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordResetAction,
    IDLE_AUTH_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.status === "error" && state.message && (
        <FormMessage status="error">{state.message}</FormMessage>
      )}
      {/* Shown whether or not that address has an account — the wording is
          chosen so it is true either way. Confirming which it was would turn
          this form into the account-existence oracle the sign-in copy is
          careful not to be. */}
      {state.status === "success" && state.message && (
        <FormMessage status="success">{state.message}</FormMessage>
      )}

      <FormField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.fieldErrors.email}
      />

      <Button type="submit" className="w-full" isLoading={pending}>
        Send reset link
      </Button>

      <p className="text-body-sm text-fg-subtle">
        <Link href="/signin" className="hover:text-fg underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
