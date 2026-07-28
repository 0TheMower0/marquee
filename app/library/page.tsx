import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/empty-state";
import { BookmarkIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "My Library" };

export default function LibraryPage() {
  return (
    <EmptyState
      icon={<BookmarkIcon />}
      title="Your library is empty"
      body="Titles you watchlist or mark as watched will show up here. Tracking state arrives in Phase 2."
      className="min-h-[70vh]"
    />
  );
}
