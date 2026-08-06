"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { signInAction } from "@/lib/auth/actions";
import { IDLE_AUTH_STATE } from "@/lib/auth/form-state";

import { FormField, FormMessage } from "./form-field";

export function SignInForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(signInAction, IDLE_AUTH_STATE);

  return (
    <form action={formAction} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}

      {state.status === "error" && state.message && (
        <FormMessage status="error">{state.message}</FormMessage>
      )}

      <FormField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state.fieldErrors.email}
      />

      <FormField
        label="Password"
        name="password"
        type="password"
        // "current-password", not "password" — it is what tells a password
        // manager to fill rather than to offer generating a new one.
        autoComplete="current-password"
        required
        error={state.fieldErrors.password}
      />

      <Button type="submit" className="w-full" isLoading={pending}>
        Sign in
      </Button>

      <div className="text-body-sm text-fg-subtle flex flex-wrap justify-between gap-x-4 gap-y-1">
        <Link href="/forgot-password" className="hover:text-fg underline">
          Forgot your password?
        </Link>
        <Link href="/signup" className="hover:text-fg underline">
          Create an account
        </Link>
      </div>
    </form>
  );
}
