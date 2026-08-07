import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertIcon, ListIcon } from "@/components/ui/icons";
import { getAccount } from "@/lib/auth";
import { getListDetail } from "@/lib/lists/queries";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { ListDetailClient, ListDetailSkeleton } from "./list-detail-client";

/**
 * The server-rendered entry point for one list's page.
 *
 * ============================================================================
 * TRY/CATCH + OWN SUSPENSE BOUNDARY — the exact lesson from Step 6a
 * ============================================================================
 * `getListDetail` is a real network round trip (four Supabase queries) that
 * can fail for reasons that have nothing to do with whether the list itself
 * is fine — a schema-cache miss mid-deploy, a transient network blip. Before
 * `CommentSection` had this same guard, a failure exactly like that took the
 * ENTIRE title page down through `app/error.tsx`. `app/lists/[id]/page.tsx`
 * wraps this component in its own `<Suspense>`, and this component wraps its
 * own fetch in try/catch, so a list failure degrades to a message here and
 * nothing above it (the nav shell, anything else on the page) is affected.
 */
export async function ListDetail({ listId }: { listId: string }) {
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
        title="Sign in to view this list"
        body="Shareable links work for any signed-in Marquee account — everything else on the site works exactly the same either way."
        action={
          <Button href={`/signin?next=${encodeURIComponent(`/lists/${listId}`)}`} size="sm">
            Sign in
          </Button>
        }
        className="py-14"
      />
    );
  }

  let list;
  try {
    list = await getListDetail(listId);
  } catch (error) {
    console.error("[lists] detail failed to load", error);
    return (
      <EmptyState
        tone="danger"
        icon={<AlertIcon />}
        title="This list couldn't load"
        body="Something went wrong loading it. Try again in a moment."
        className="py-14"
      />
    );
  }

  // `getListDetail` returns null for BOTH "doesn't exist" and "you can't see
  // it" — deliberately indistinguishable, see the doc comment there. A plain
  // 404 is the honest response to both.
  if (!list) notFound();

  return <ListDetailClient initialList={list} viewerId={account.user.id} />;
}

export { ListDetailSkeleton };
