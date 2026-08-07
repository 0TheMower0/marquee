import type { Metadata } from "next";
import { Suspense } from "react";

import { ListsOverview, ListsOverviewSkeleton } from "@/components/lists/lists-overview";

export const metadata: Metadata = { title: "Lists" };

export default function ListsPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Its own Suspense boundary — ListsOverview reads the session and runs
          four Supabase queries, none of which should sit in this route's
          time-to-first-byte, matching every other secondary-data section in
          this app (RatingsSection, CommentSection, AccountCard). */}
      <Suspense fallback={<ListsOverviewSkeleton />}>
        <ListsOverview />
      </Suspense>
    </div>
  );
}
