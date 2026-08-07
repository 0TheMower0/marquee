import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListIcon } from "@/components/ui/icons";
import { SkeletonGrid } from "@/components/ui/skeleton";
import { getAccount } from "@/lib/auth";
import {
  getCollaboratingLists,
  getFollowedLists,
  getMyLists,
  getPublicLists,
} from "@/lib/lists/queries";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { ListsOverviewClient } from "./lists-overview-client";

/**
 * Lists require an account, same reasoning `CommentSection` documents for
 * comments — a list needs an owner with a username to render meaningfully,
 * and `profiles` is only readable signed in.
 *
 * Every fetch degrades independently. A failure on ONE group (say,
 * `getPublicLists`) must not blank out the other three, so each is awaited
 * inside its own try/catch rather than one shared try around
 * `Promise.all` — a single throw there would take every group down together
 * even though the other three queries succeeded.
 */
export async function ListsOverview() {
  if (!isSupabaseConfigured()) {
    return (
      <EmptyState
        icon={<ListIcon />}
        title="Lists aren't available here"
        body="This build has no account service configured, so there's nowhere for a list to live."
        className="py-14"
      />
    );
  }

  const account = await getAccount();
  if (!account) {
    return (
      <EmptyState
        icon={<ListIcon />}
        title="Sign in to create and follow lists"
        body="Lists are tied to your account so you can share them and collaborate with others."
        action={
          <Button href="/signin?next=/lists" size="sm">
            Sign in
          </Button>
        }
        className="py-14"
      />
    );
  }

  const [mine, collaborating, following, discover] = await Promise.all([
    fetchOrEmpty(getMyLists, "my lists"),
    fetchOrEmpty(getCollaboratingLists, "collaborating lists"),
    fetchOrEmpty(getFollowedLists, "followed lists"),
    fetchOrEmpty(() => getPublicLists(), "public lists"),
  ]);

  return (
    <ListsOverviewClient
      mine={mine}
      collaborating={collaborating}
      following={following}
      discover={discover}
    />
  );
}

async function fetchOrEmpty<T>(fn: () => Promise<T[]>, label: string): Promise<T[]> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[lists] ${label} failed to load`, error);
    return [];
  }
}

export function ListsOverviewSkeleton() {
  return (
    <div>
      <div className="bg-overlay h-9 w-32 animate-pulse rounded-sm" />
      <SkeletonGrid count={6} label="Loading lists" className="mt-6" />
    </div>
  );
}
