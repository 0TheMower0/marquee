import { getAccount } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { UserIcon } from "@/components/ui/icons";

import { SyncBadge } from "@/components/sync/sync-status";

import { SignOutButton } from "./account-forms";

/**
 * The account strip on the Profile page.
 *
 * A Server Component, and that is the whole reason it is a separate file from
 * `ProfileView` (which is a Client Component reading localStorage). Rendering
 * identity on the server means the correct state is in the first HTML byte —
 * no flash of "Sign in" for someone who is already signed in, and no client
 * -side session read that could disagree with what the server believes.
 *
 * ============================================================================
 * THE COPY IS THE FEATURE
 * ============================================================================
 * All three states say some version of "this works without an account." That
 * is not filler. The brief for this phase is that signing in is an upgrade and
 * never a gate, and the only way a user learns that is by being told it at the
 * exact moment they are deciding — which is here.
 */
export async function AccountCard() {
  // The unconfigured deployment. No `getAccount()` call at all, so this stays
  // a static render and costs an anonymous visitor nothing.
  if (!isSupabaseConfigured()) {
    return (
      <Card as="section">
        <CardHeader>
          <CardTitle>This device only</CardTitle>
        </CardHeader>
        <CardBody>
          Everything you track lives in this browser. This build has no account
          service configured, so there is nothing to sign in to — and nothing
          leaves the device.
        </CardBody>
      </Card>
    );
  }

  const account = await getAccount();

  if (!account) {
    return (
      <Card as="section">
        <CardHeader>
          <CardTitle>Sync across devices</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p>
            Marquee works fully without an account — everything you have already
            tracked is on this device and stays there. An account adds syncing
            between devices, and nothing else.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button href="/signin" size="sm">
              Sign in
            </Button>
            <Button href="/signup" variant="outline" size="sm">
              Create an account
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card as="section">
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <SignOutButton />
      </CardHeader>
      <CardBody className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="bg-accent/15 text-accent flex size-10 shrink-0 items-center justify-center rounded-full">
            <UserIcon className="size-5" />
          </span>
          <div className="min-w-0">
            {/* Usernames are mixed-case and user-authored, so they render in
                the sans face. Bebas has no lowercase — a username in
                font-display would silently become a different string. */}
            <p className="text-body text-fg truncate font-medium">
              {account.profile?.username ?? "Setting up…"}
            </p>
            <p className="text-meta text-fg-subtle truncate">
              {account.user.email ?? "No email on this account"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* The compact indicator renders nothing while sync is healthy, so
              this row only appears when there is something to say. Failure has
              to be visible somewhere the user actually goes, and Profile is
              visited far more often than /account. */}
          <SyncBadge />
        </div>

        <p className="text-body-sm text-fg-subtle">
          Your library lives on this device and syncs to your account in the
          background.
        </p>

        <Button href="/account" variant="outline" size="sm">
          Account settings
        </Button>
      </CardBody>
    </Card>
  );
}
