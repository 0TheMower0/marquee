"use client";

import Link from "next/link";

import { cn } from "@/lib/utils/cn";
import { NAV_ITEMS, type NavItem } from "./nav-items";
import { useActivePath } from "./use-active-path";

/**
 * Mobile navigation, hidden at `lg` (1024px) and above where Sidebar takes
 * over. Fixed to the viewport bottom; `env(safe-area-inset-bottom)` keeps it
 * clear of the home-indicator area on notched phones.
 */
export function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="bg-surface border-line-subtle fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {/* grid-cols-4 matches NAV_ITEMS.length — update both together if a
          route is ever added or removed. */}
      <ul className="grid grid-cols-4">
        {NAV_ITEMS.map((item) => (
          <BottomNavItem key={item.href} item={item} />
        ))}
      </ul>
    </nav>
  );
}

function BottomNavItem({ item }: { item: NavItem }) {
  const isActive = useActivePath(item.href);
  const Icon = item.icon;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "text-meta-sm flex flex-col items-center gap-1 py-2.5 uppercase",
          "motion-safe:transition-colors motion-safe:duration-[--dur-fast]",
          // Gold marks the active route. Distinct from the global cyan
          // :focus-visible ring, which still applies here unmodified.
          isActive ? "text-accent" : "text-fg-subtle hover:text-fg-muted",
        )}
      >
        <Icon className="size-5" />
        {item.label}
      </Link>
    </li>
  );
}
