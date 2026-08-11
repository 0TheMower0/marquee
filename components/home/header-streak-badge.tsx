"use client";

import { StreakBadge } from "@/components/streak/streak-badge";

import { useHomeConfig } from "./use-home-config";

/**
 * Home's own gate layered on top of StreakBadge's existing one. StreakBadge
 * already renders nothing when there's no active streak — it has no idea
 * this setting exists, and shouldn't need to; gating on the preference lives
 * here instead of teaching a streak component about home_config.
 */
export function HeaderStreakBadge() {
  const { config } = useHomeConfig();
  if (!config.showStreakBadge) return null;
  return <StreakBadge />;
}
