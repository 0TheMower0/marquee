"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import {
  signOutAction,
  updatePasswordAction,
  updateUsernameAction,
} from "@/lib/auth/actions";
import { IDLE_AUTH_STATE } from "@/lib/auth/form-state";
import { USERNAME_MAX_LENGTH } from "@/lib/auth/username";

import { FormField, FormMessage } from "./form-field";

export function UsernameForm({ current }: { current: string }) {
  const [state, formAction, pending] = useActionState(
    updateUsernameAction,
    IDLE_AUTH_STATE,
  );
  // Uncontrolled would be simpler, but the input must reflect the value the
  // server accepted after a successful rename, and `defaultValue` does not
  // update on re-render. `key` on the field would remount it and lose focus.
  const [value, setValue] = useState(current);

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Username</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={formAction} className="space-y-4">
          {state.status === "error" && state.message && !state.fieldErrors.username && (
            <FormMessage status="error">{state.message}</FormMessage>
          )}
          {state.status === "success" && state.message && (
            <FormMessage status="success">{state.message}</FormMessage>
          )}

          <FormField
            label="Your username"
            name="username"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="username"
            maxLength={USERNAME_MAX_LENGTH}
            required
            error={state.fieldErrors.username}
            hint="How you'll appear to other people once comments and shared lists arrive."
          />

          <Button
            type="submit"
            variant="secondary"
            isLoading={pending}
            disabled={value.trim() === current}
          >
            Save username
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function PasswordForm({ recovery = false }: { recovery?: boolean }) {
  const [state, formAction, pending] = useActionState(
    updatePasswordAction,
    IDLE_AUTH_STATE,
  );

  return (
    <Card as="section" id="password">
      <CardHeader>
        <CardTitle>{recovery ? "Set a new password" : "Password"}</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={formAction} className="space-y-4">
          {recovery && state.status === "idle" && (
            <FormMessage status="success">
              You&rsquo;re signed in from a recovery link. Choose a new password
              now — that link only works once.
            </FormMessage>
          )}
          {state.status === "error" && state.message && (
            <FormMessage status="error">{state.message}</FormMessage>
          )}
          {state.status === "success" && state.message && (
            <FormMessage status="success">{state.message}</FormMessage>
          )}

          <FormField
            label="New password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            error={state.fieldErrors.password}
            hint="At least 8 characters."
          />
          <FormField
            label="Confirm new password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            error={state.fieldErrors.confirmPassword}
          />

          <Button type="submit" variant="secondary" isLoading={pending}>
            Update password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function SignOutButton({
  variant = "ghost",
}: {
  variant?: "ghost" | "secondary";
}) {
  return (
    <form action={signOutAction}>
      <SignOutSubmit variant={variant} />
    </form>
  );
}

function SignOutSubmit({ variant }: { variant: "ghost" | "secondary" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" isLoading={pending}>
      Sign out
    </Button>
  );
}
