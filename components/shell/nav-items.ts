import type { ComponentType } from "react";

import {
  BookmarkIcon,
  HomeIcon,
  SearchIcon,
  UserIcon,
  type IconProps,
} from "@/components/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<IconProps>;
}

/**
 * Single source of truth for the four Phase 1 routes. BottomNav and Sidebar
 * both render from this list rather than hardcoding links twice, so mobile
 * and desktop can never silently drift out of sync.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/library", label: "Library", icon: BookmarkIcon },
  { href: "/profile", label: "Profile", icon: UserIcon },
];
