import Link from "next/link";

import type { ListSummary } from "@/lib/lists";

import { MemberAvatar, memberLabel } from "./member-avatar";
import { VisibilityBadge } from "./visibility-badge";

/**
 * One list in a grid — "My Lists", "Collaborating", "Following", "Discover"
 * all render the same card, same reasoning TicketCard gets reused across
 * Home/Search/Library: one card, no per-surface drift.
 */
export function ListCard({ list }: { list: ListSummary }) {
  return (
    <Link
      href={`/lists/${list.id}`}
      className="border-line-subtle bg-surface hover:border-accent/50 focus-visible:ring-accent flex flex-col gap-3 rounded-lg border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-display text-display-sm text-fg truncate uppercase">
          {list.name}
        </h3>
        <VisibilityBadge visibility={list.visibility} size="sm" />
      </div>

      {list.description && (
        <p className="text-body-sm text-fg-muted line-clamp-2">{list.description}</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2">
          <MemberAvatar member={list.owner} size="sm" />
          <span className="text-meta text-fg-subtle truncate">
            {list.isOwn ? "You" : memberLabel(list.owner)}
          </span>
        </div>
        <div className="text-meta text-fg-subtle flex shrink-0 items-center gap-3">
          <span>{list.itemCount} title{list.itemCount === 1 ? "" : "s"}</span>
          <span>{list.followerCount} follower{list.followerCount === 1 ? "" : "s"}</span>
        </div>
      </div>
    </Link>
  );
}

export function ListCardGrid({ lists }: { lists: ListSummary[] }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {lists.map((list) => (
        <li key={list.id}>
          <ListCard list={list} />
        </li>
      ))}
    </ul>
  );
}
