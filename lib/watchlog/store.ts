import { defineStore } from "@/lib/storage";

import { isWatchLogDay, type WatchLogDay } from "./types";

/**
 * Version 1 — the first schema, nothing to migrate yet. The empty
 * `migrations` object is a deliberate marker: read the migration-design note
 * under "Local persistence" in CLAUDE.md before adding `migrations[2]`.
 * Records migrate lazily per record on read, so a v1 record can still be in a
 * browser years from now and `migrations[2]` could never be deleted.
 *
 * Keys in this namespace are ALWAYS day keys ("YYYY-MM-DD") and nothing else.
 * That is load-bearing rather than incidental: `keys()` is used directly as
 * the set of days with activity (see ./queries.ts), so a stray metadata key
 * would silently corrupt every streak. "Tracking since" is derived as the
 * earliest key precisely so no such record is needed.
 */
export const watchLogStore = defineStore<WatchLogDay>({
  namespace: "watchlog",
  version: 1,
  migrations: {},
  validate: isWatchLogDay,
});
