"use client";

import { Button } from "@/components/ui/button";
import { AlertIcon, BellIcon, CheckIcon } from "@/components/ui/icons";

import { usePushSubscription } from "./use-push-subscription";

/**
 * The enable/disable control for THIS device, plus the explanation that has
 * to come before the permission prompt.
 *
 * ============================================================================
 * NEVER A DEAD BUTTON
 * ============================================================================
 * Every unsupported case renders something that says what is actually true,
 * and — where there is one — the action that would fix it. In particular iOS
 * Safari before Add to Home Screen gets real instructions rather than a
 * disabled toggle with a tooltip, because installing genuinely does enable
 * the feature. Design doc §9.
 *
 * The copy above the button exists so the browser's own permission dialog —
 * which says nothing useful, and which cannot be re-shown once dismissed — is
 * never the first time someone learns what they are agreeing to.
 */
export function PushSetupCard() {
  const { capability, subscribed, busy, error, configured, subscribe, unsubscribe } =
    usePushSubscription();

  // `unknown` is the pre-effect state. Rendering a disabled control here would
  // flash on every page load before resolving.
  if (capability.kind === "unknown") return null;

  if (!configured) {
    return (
      <Panel tone="muted">
        <p className="text-body-sm text-fg">Notifications aren&rsquo;t set up on this server.</p>
        <p className="text-meta text-fg-muted">
          Everything else in Marquee works normally &mdash; this feature just
          isn&rsquo;t configured.
        </p>
      </Panel>
    );
  }

  if (capability.kind === "ios-not-installed") {
    return (
      <Panel tone="muted">
        <p className="text-body-sm text-fg font-medium">Add Marquee to your Home Screen first</p>
        <p className="text-meta text-fg-muted">
          On iPhone and iPad, notifications only work once the app is installed.
          Tap the Share button, then <strong>Add to Home Screen</strong>, and open
          Marquee from there.
        </p>
        <p className="text-meta text-fg-subtle">
          This has to be done in Safari &mdash; Chrome and Firefox on iOS
          can&rsquo;t install web apps.
        </p>
      </Panel>
    );
  }

  if (capability.kind === "permission-denied") {
    return (
      <Panel tone="warning">
        <p className="text-body-sm text-fg font-medium">Notifications are blocked</p>
        <p className="text-meta text-fg-muted">
          This site&rsquo;s notification permission was declined, and only you can
          undo it &mdash; look for the lock or bell icon in the address bar, or
          this site&rsquo;s entry in your browser settings.
        </p>
      </Panel>
    );
  }

  if (capability.kind === "unsupported") {
    return (
      <Panel tone="muted">
        <p className="text-body-sm text-fg">This browser doesn&rsquo;t support notifications.</p>
        <p className="text-meta text-fg-muted">
          Everything else works normally. Try a recent version of Chrome, Edge,
          Firefox, or Safari.
        </p>
      </Panel>
    );
  }

  return (
    <Panel tone={subscribed ? "accent" : "muted"}>
      {subscribed ? (
        <>
          <p className="text-body-sm text-fg flex items-center gap-2 font-medium">
            <CheckIcon className="text-accent size-4 shrink-0" />
            Notifications are on for this device
          </p>
          <p className="text-meta text-fg-muted">
            You&rsquo;ll hear about new episodes for the shows you follow below.
            Each device is separate &mdash; turn this on again on your phone or
            laptop to get them there too.
          </p>
          <Button size="sm" variant="outline" onClick={() => void unsubscribe()} disabled={busy} isLoading={busy}>
            Turn off on this device
          </Button>
        </>
      ) : (
        <>
          <p className="text-body-sm text-fg font-medium">Get notified about new episodes</p>
          <p className="text-meta text-fg-muted">
            Marquee will let you know when a show you follow airs a new episode,
            or gets a new season announced. Nothing else &mdash; no reminders
            about what you haven&rsquo;t watched, and no suggestions.
          </p>
          <p className="text-meta text-fg-subtle">
            You choose which shows, one at a time. Your browser will ask for
            permission next.
          </p>
          <Button size="sm" variant="primary" onClick={() => void subscribe()} disabled={busy} isLoading={busy}>
            <BellIcon className="size-4" />
            Enable on this device
          </Button>
        </>
      )}

      {error && (
        <p role="alert" className="text-danger text-meta flex items-start gap-2">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
    </Panel>
  );
}

function Panel({
  tone,
  children,
}: {
  tone: "muted" | "warning" | "accent";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warning"
      ? "border-warning/40 bg-warning/10"
      : tone === "accent"
        ? "border-accent/40 bg-accent/10"
        : "border-line-subtle bg-surface";

  return (
    <div className={`flex flex-col items-start gap-2 rounded-md border px-4 py-3 ${toneClass}`}>
      {children}
    </div>
  );
}
