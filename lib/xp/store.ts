import { defineStore } from "@/lib/storage";

/**
 * One record, holding the highest level the level-up celebration has already
 * been shown for. Goes through `defineStore` like every other persisted
 * value in the app — including for a single scalar — rather than touching
 * `localStorage` directly, so it gets the same namespacing, versioning, and
 * driver abstraction (memory fallback, SSR-safe null driver) as everything
 * else. See lib/storage's public surface.
 *
 * Why this needs to be PERSISTED at all, not just a `useRef`: XP is computed
 * fresh on every render from current tracking state, so "did the level just
 * increase" can only be answered by comparing against a REMEMBERED prior
 * level — a value that has to survive a reload, or every visit to a page
 * showing the XP bar would either always re-fire the celebration (compared
 * against a hardcoded start) or never fire it (compared against the value
 * computed on the same render).
 */
export interface SeenLevelRecord {
  highestLevelSeen: number;
}

const KEY = "seen";

function isSeenLevelRecord(data: unknown): data is SeenLevelRecord {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as SeenLevelRecord).highestLevelSeen === "number" &&
    Number.isInteger((data as SeenLevelRecord).highestLevelSeen)
  );
}

export const seenLevelStore = defineStore<SeenLevelRecord>({
  namespace: "xp-seen-level",
  version: 1,
  migrations: {},
  validate: isSeenLevelRecord,
});

export async function getHighestLevelSeen(): Promise<number> {
  const record = await seenLevelStore.get(KEY);
  return record?.highestLevelSeen ?? 1; // everyone starts at level 1
}

/** Best-effort, same as the watch log's appends: failing to persist "you've
 *  seen this" is not worth surfacing as an error to the user — worst case
 *  the celebration replays once more than it should. */
export async function setHighestLevelSeen(level: number): Promise<void> {
  try {
    await seenLevelStore.set(KEY, { highestLevelSeen: level });
  } catch (error) {
    console.warn("[xp] could not persist highest level seen.", error);
  }
}
