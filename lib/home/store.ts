import { defineStore } from "@/lib/storage";
import { recordHomeConfig } from "@/lib/sync/record";

import { HOME_CONFIG_KEY, HOME_CONFIG_NAMESPACE, isHomeConfig, type HomeConfig } from "./types";

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
  namespace: HOME_CONFIG_NAMESPACE,
  version: 1,
  migrations: {},
  validate: isHomeConfig,
});

export async function getHomeConfig(): Promise<HomeConfig | null> {
  return homeConfigStore.get(HOME_CONFIG_KEY);
}

/**
 * The UI-facing write path — settings screens call this. It queues an
 * outbox write after the local write succeeds (same "local first, always"
 * rule as every other recorder in lib/sync/record.ts).
 *
 * The sync engine's own pull-apply and restore-from-backup paths do NOT go
 * through this function — they write straight to `homeConfigStore` (see
 * lib/sync/engine.ts and lib/sync/backup.ts), the same way
 * `lib/xp/store.ts`'s `seenLevelStore` is written directly from those two
 * call sites. Routing a just-pulled or just-restored value back through this
 * function would re-enqueue it right back into the outbox it came from (or,
 * for restore, push a value nothing server-side asked for).
 */
export async function setHomeConfig(config: HomeConfig): Promise<void> {
  await homeConfigStore.set(HOME_CONFIG_KEY, config);
  void recordHomeConfig(config);
}
