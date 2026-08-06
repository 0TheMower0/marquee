"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { checkUsernameAction, signUpAction } from "@/lib/auth/actions";
import { IDLE_AUTH_STATE } from "@/lib/auth/form-state";
import {
  USERNAME_MAX_LENGTH,
  USERNAME_REJECTION_MESSAGE,
  validateUsername,
} from "@/lib/auth/username";

import { FormField, FormMessage } from "./form-field";

/** Long enough that a fast typist isn't checked mid-word, short enough that
 *  the answer arrives before they reach the password field. Same order of
 *  magnitude as the search debounce. */
const AVAILABILITY_DEBOUNCE_MS = 400;

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, IDLE_AUTH_STATE);
  const [username, setUsername] = useState("");

  /**
   * The last availability answer, tagged with the name it was an answer FOR.
   *
   * Tagged rather than stored as a bare boolean for the same reason
   * `search-view.tsx` tags its results with `forKey`: comparing the tag
   * against the current input is what makes "checking" a DERIVED state
   * instead of a second `useState`, and a stale in-flight answer can never
   * paint over a newer one. eslint's `react-hooks/set-state-in-effect` also
   * rejects a synchronous `setState("checking")` at the top of the effect, so
   * this is the shape that both works and lints.
   */
  const [checked, setChecked] = useState<{ forName: string; available: boolean } | null>(
    null,
  );

  const trimmed = username.trim();
  const localCheck = validateUsername(trimmed);

  useEffect(() => {
    // Re-validated inside rather than depending on `localCheck`, which is a new
    // object every render and would make the effect fire on every keystroke of
    // any field.
    const check = validateUsername(username);
    if (!check.ok) return;
    const name = check.value;

    const timer = setTimeout(() => {
      checkUsernameAction(name)
        .then((available) => setChecked({ forName: name, available }))
        // Availability is decoration over a unique index — a failed check must
        // never block the form, so it simply leaves the hint blank.
        .catch(() => {});
    }, AVAILABILITY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [username]);

  const usernameHint = (() => {
    if (trimmed.length === 0) return `Letters, numbers and underscores. Up to ${USERNAME_MAX_LENGTH}.`;
    if (!localCheck.ok) return USERNAME_REJECTION_MESSAGE[localCheck.reason];
    if (checked?.forName !== localCheck.value) return "Checking availability…";
    return checked.available ? `${checked.forName} is available.` : `${checked.forName} is taken.`;
  })();

  if (state.awaitingVerification) {
    return (
      <div className="space-y-4">
        <FormMessage status="success">
          Account created. Check your inbox for a confirmation link, then sign in.
        </FormMessage>
        <p className="text-body-sm text-fg-subtle">
          Nothing on this device has changed — everything you have already
          tracked is still here, signed in or not.
        </p>
        <Button href="/signin" variant="outline" className="w-full">
          Go to sign in
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.status === "error" && state.message && (
        <FormMessage status="error">{state.message}</FormMessage>
      )}

      <FormField
        label="Username"
        name="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        maxLength={USERNAME_MAX_LENGTH}
        required
        error={state.fieldErrors.username}
        hint={usernameHint}
      />

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
        // "new-password" invites a password manager to generate one, which is
        // the opposite of the sign-in form's "current-password".
        autoComplete="new-password"
        minLength={8}
        required
        error={state.fieldErrors.password}
        hint="At least 8 characters."
      />

      <Button type="submit" className="w-full" isLoading={pending}>
        Create account
      </Button>

      <p className="text-body-sm text-fg-subtle">
        Already have one?{" "}
        <Link href="/signin" className="hover:text-fg underline">
          Sign in
        </Link>
        .
      </p>
    </form>
  );
}
