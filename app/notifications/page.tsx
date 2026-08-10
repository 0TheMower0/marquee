import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";

import { NotificationSettings } from "@/components/notifications/notification-settings";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BellIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getNotificationSettings } from "@/lib/notifications/queries";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="font-display text-display-xl text-fg uppercase">Notifications</h1>
        <p className="text-body text-fg-muted mt-1 max-w-prose">
          Get told when a show you follow airs something new.
        </p>
      </header>

      {/* Its own boundary — this reads the session and three tables, none of
          which should sit in the route's time to first byte. Same reasoning as
          AccountCard, RatingsSection and CommentSection. */}
      <div className="mt-8">
        <Suspense fallback={<SettingsSkeleton />}>
          <SettingsSection />
        </Suspense>
      </div>
    </div>
  );
}

async function SettingsSection() {
  let settings;

  // Only the await belongs in the try — JSX built inside would let a render
  // error sail past this catch, which eslint's react-hooks/error-boundaries
  // enforces. And the catch matters: Phase 6 Step 6a took down an entire title
  // page because CommentSection had no try/catch around exactly this shape of
  // call, and a transient schema-cache miss propagated to app/error.tsx.
  try {
    settings = await getNotificationSettings();
  } catch (error) {
    // Next signals things like "this route is dynamic because it read
    // cookies()" by THROWING an internal error. Swallowing it here made the
    // build log a bogus failure and would have kept the route from being
    // marked dynamic at all — the catch was eating a control-flow signal, not
    // an error. `unstable_rethrow` re-throws exactly those and lets genuine
    // failures fall through. Caught by reading the build output rather than
    // by any test.
    unstable_rethrow(error);
    console.error("[marquee] notifications settings failed to load", error);
    return (
      <p role="alert" className="text-danger text-body-sm">
        Couldn&rsquo;t load your notification settings. Everything else still works.
      </p>
    );
  }

  // null means unconfigured OR signed out — both render as an invitation
  // rather than an error, since neither is broken.
  if (!settings) {
    return (
      <EmptyState
        icon={<BellIcon />}
        title="Sign in to set up notifications"
        body="Push notifications need an account, because your device has to be reachable while Marquee is closed. Everything else in the app works without one."
        action={
          <Button href="/signin?next=%2Fnotifications" variant="primary" size="sm">
            Sign in
          </Button>
        }
      />
    );
  }

  return <NotificationSettings initial={settings} />;
}

function SettingsSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy="true">
      <span className="sr-only">Loading notification settings</span>
      <Skeleton className="h-24 w-full rounded-md" />
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-16 w-full rounded-md" />
    </div>
  );
}
