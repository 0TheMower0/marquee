"use client";

import { usePathname } from "next/navigation";

/**
 * "/" only matches exactly — otherwise Home would light up as active on
 * every route, since every path starts with "/". Every other item matches
 * itself or anything nested under it, so e.g. a future `/library/watched`
 * still highlights "Library".
 */
export function useActivePath(href: string): boolean {
  const pathname = usePathname();
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
