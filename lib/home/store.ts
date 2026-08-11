import { defineStore } from "@/lib/storage";

import { isHomeConfig, type HomeConfig } from "./types";

/**
 * One record, same "single scalar still goes through `defineStore`" reasoning
 * as `lib/xp/store.ts`'s `seenLevelStore` — namespacing, versioning, and the
 * memory/null driver fallback for free, rather than touching `localStorage`
 * directly for the one store in the app that happens to hold only one row.
 *
 * Version 1, no migrations yet. `HomeConfig` is expected to grow (more
 * toggles, later) — see the note on `home_config.config` being a single
 * jsonb column in the migration for why that growth is a `lib/storage`
 * migration here, not a new server column.
 */
export const homeConfigStore = defineStore<HomeConfig>({
  namespace: "home-config",
  version: 1,
  migrations: {},
  validate: isHomeConfig,
});

const KEY = "config";

export async function getHomeConfig(): Promise<HomeConfig | null> {
  return homeConfigStore.get(KEY);
}

export async function setHomeConfig(config: HomeConfig): Promise<void> {
  await homeConfigStore.set(KEY, config);
}
