"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/icons";
import { startOAuthAction } from "@/lib/auth/actions";

/**
 * OAuth sign-in.
 *
 * A real `<form>` posting to a Server Action rather than an onClick handler:
 * the flow ends in a cross-origin redirect, which a server action performs
 * natively and which a client-side `window.location =` would have to
 * reconstruct. It also means the button works before hydration.
 */
export function OAuthButtons({ next }: { next?: string }) {
  return (
    <form action={startOAuthAction} className="space-y-3">
      <input type="hidden" name="provider" value="github" />
      {next && <input type="hidden" name="next" value={next} />}
      <OAuthSubmit />
    </form>
  );
}

function OAuthSubmit() {
  // useFormStatus reads the pending state of the enclosing form, which is why
  // this is a separate component — the hook returns nothing useful when called
  // in the component that renders the <form> itself.
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="secondary" className="w-full" isLoading={pending}>
      <GitHubIcon className="size-4" />
      Continue with GitHub
    </Button>
  );
}

/** The "or" rule between OAuth and the email form. Purely decorative, so the
 *  text is hidden from assistive tech — a screen reader announcing "or"
 *  between two labelled sections adds nothing. */
export function AuthDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-line-subtle h-px flex-1" />
      <span className="text-meta-sm text-fg-subtle uppercase">or</span>
      <span className="bg-line-subtle h-px flex-1" />
    </div>
  );
}
