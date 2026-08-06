import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The narrow centred column every auth page uses.
 *
 * `max-w-md` with page padding, so the form is comfortable at 375px and does
 * not stretch to an unreadable line length on a desktop — a full-width text
 * input is harder to use, not easier.
 */
export function AuthPageShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-md p-6 sm:p-8">
      <h1 className="font-display text-display-lg text-fg uppercase">{title}</h1>
      {intro && <div className="text-body-sm text-fg-subtle mt-2">{intro}</div>}

      <Card padding="lg" className="mt-6">
        {children}
      </Card>

      {footer && <div className="mt-6">{footer}</div>}
    </div>
  );
}

/**
 * What an auth route renders when the deployment has no Supabase project.
 *
 * A page, not a 404. These routes exist in the build either way, and someone
 * arriving at `/signin` on a local zero-config copy should be told what is
 * actually going on — "not found" would read as a broken app rather than as an
 * unconfigured one. The link back to Home reinforces the same point every
 * other surface makes: nothing here is gated.
 */
export function AuthUnavailable({ title }: { title: string }) {
  return (
    <AuthPageShell
      title={title}
      intro="This copy of Marquee has no account service configured."
    >
      <div className="space-y-4">
        <p className="text-body-sm text-fg-muted">
          That is a supported way to run it, not a fault. Everything works —
          tracking, ratings, stats, badges — it all just lives in this browser
          rather than syncing anywhere.
        </p>
        <Button href="/" variant="outline" className="w-full">
          Back to Marquee
        </Button>
      </div>
    </AuthPageShell>
  );
}
