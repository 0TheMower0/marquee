"use client";

import Link from "next/link";

import { cn } from "@/lib/utils/cn";
import { NAV_ITEMS, type NavItem } from "./nav-items";
import { useActivePath } from "./use-active-path";

/** Width is shared with the `lg:pl-56` offset applied to the content column
 *  in app/layout.tsx — the two numbers must move together. */
export const SIDEBAR_WIDTH_CLASS = "w-56";

/**
 * Desktop navigation, hidden below `lg` (1024px) where BottomNav takes over.
 */
export function Sidebar() {
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "border-line-subtle bg-surface fixed inset-y-0 left-0 z-40 hidden flex-col border-r lg:flex",
        SIDEBAR_WIDTH_CLASS,
      )}
    >
      <Link
        href="/"
        className="px-5 py-6 focus-visible:outline-offset-[-2px]"
      >
        <span className="font-display text-display-md text-accent uppercase">
          Marquee
        </span>
      </Link>

      <ul className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => (
          <SidebarItem key={item.href} item={item} />
        ))}
      </ul>
    </nav>
  );
}

function SidebarItem({ item }: { item: NavItem }) {
  const isActive = useActivePath(item.href);
  const Icon = item.icon;

  return (
    <li>
      <Link
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "font-display text-display-sm flex items-center gap-3 rounded-md px-3 py-2.5 uppercase",
          "motion-safe:transition-colors motion-safe:duration-[--dur-fast]",
          isActive
            ? "bg-accent/12 text-accent"
            : "text-fg-muted hover:bg-overlay hover:text-fg",
        )}
      >
        <Icon className="size-5 shrink-0" />
        {item.label}
      </Link>
    </li>
  );
}
