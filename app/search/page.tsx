import type { Metadata } from "next";

import { EmptyState } from "@/components/ui/empty-state";
import { SearchIcon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return (
    <EmptyState
      icon={<SearchIcon />}
      title="Search"
      body="Find any film or series by name. This lands in Phase 2 — searchTitles() already works in both content providers, it just isn't wired to a search box yet."
      className="min-h-[70vh]"
    />
  );
}
