"use client";

import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_HOME_CONFIG,
  getHomeConfig,
  moveSection,
  setHomeConfig,
  toggleSection,
  type FirstPage,
  type HomeConfig,
  type HomeSectionId,
} from "@/lib/home";

/**
 * Orchestration for both consumers of `HomeConfig` — the settings screen
 * (reads AND writes) and `HomeSections`/the streak badge on Home (reads
 * only) — same shared-hook idiom as `useStreak`/`useXp`.
 *
 * `ready` starts false on both server and client, and the very first client
 * render before the effect resolves falls back to `DEFAULT_HOME_CONFIG` —
 * matching what the server rendered, so there is no hydration mismatch. Once
 * the real config loads, the DOM updates to match it; a user who customized
 * Home sees one reflow on load, not a flash of the wrong layout persisted
 * anywhere.
 *
 * Optimistic writes with visible rollback, same shape as
 * `lib/tracking/context.tsx`'s `setStatus`: update local state immediately,
 * await the storage write, and on failure revert AND surface `writeFailed`
 * for one write's transient error banner. A dropped write here costs a
 * misordered Home layout, not a lost watch — smaller stakes than tracking —
 * but "write failure renders as success" is still the wrong default per
 * CLAUDE.md's storage section, so it gets the same treatment, just without a
 * thrown error for a caller-specific catch block (there is no single caller
 * here; the settings screen IS the only caller, and reads `writeFailed`
 * directly rather than wrapping every button in its own try/catch).
 */
export interface UseHomeConfigResult {
  ready: boolean;
  config: HomeConfig;
  writeFailed: boolean;
  setFirstPage: (page: FirstPage) => void;
  moveSectionDirection: (id: HomeSectionId, direction: "up" | "down") => void;
  toggleSectionVisible: (id: HomeSectionId) => void;
  setShowStreakBadge: (visible: boolean) => void;
}

export function useHomeConfig(): UseHomeConfigResult {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<HomeConfig>(DEFAULT_HOME_CONFIG);
  const [writeFailed, setWriteFailed] = useState(false);
  // Read once per mount; writes below update `config` directly rather than
  // re-reading, so this only ever guards the initial load.
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    getHomeConfig().then((stored) => {
      if (cancelled) return;
      setConfig(stored ?? DEFAULT_HOME_CONFIG);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function commit(next: Omit<HomeConfig, "updatedAt">) {
    const previous = config;
    const withTimestamp: HomeConfig = { ...next, updatedAt: new Date() };
    setConfig(withTimestamp);
    setWriteFailed(false);
    setHomeConfig(withTimestamp).catch(() => {
      setConfig(previous);
      setWriteFailed(true);
    });
  }

  return {
    ready,
    config,
    writeFailed,
    setFirstPage(page) {
      commit({ ...config, firstPage: page });
    },
    moveSectionDirection(id, direction) {
      commit({ ...config, sections: moveSection(config.sections, id, direction) });
    },
    toggleSectionVisible(id) {
      commit({ ...config, sections: toggleSection(config.sections, id) });
    },
    setShowStreakBadge(visible) {
      commit({ ...config, showStreakBadge: visible });
    },
  };
}
