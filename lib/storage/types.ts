/**
 * Storage layer contracts.
 *
 * Deliberately has no `server-only` guard: this is client-side state by
 * definition, and Client Components are its intended callers. It also has no
 * browser-only imports at module scope, so importing it during SSR is safe —
 * see the null driver in drivers.ts.
 */

/** Why a storage operation failed. Discriminated so call sites can react
 *  differently to "disk is full" than to "this record is corrupt". */
export type StorageErrorReason =
  | "quota_exceeded"
  | "unavailable"
  | "serialization"
  | "unknown";

export class StorageError extends Error {
  readonly reason: StorageErrorReason;

  constructor(
    reason: StorageErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StorageError";
    this.reason = reason;
  }
}

/**
 * Where data actually ended up.
 *
 * - `persistent` — localStorage; survives reload.
 * - `memory`     — localStorage exists but threw (private mode, blocked
 *                  cookies, disabled storage). Data lives for this tab only.
 * - `unavailable`— no browser environment at all (SSR). Reads return null,
 *                  writes are discarded.
 */
export type StorageStatus = "persistent" | "memory" | "unavailable";

/**
 * The swap point.
 *
 * Everything above this interface deals in typed values, namespaces and
 * migrations; a driver deals only in opaque strings. Moving to IndexedDB in
 * Phase 3 means writing one more implementation of exactly this and changing
 * the selection in drivers.ts — no call site moves.
 *
 * Every method is async even though localStorage is synchronous. That is the
 * whole point: IndexedDB is not, and an interface that is sync today cannot
 * become async later without rewriting every caller.
 */
export interface StorageDriver {
  readonly status: StorageStatus;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Full keys (including prefix) currently present under `prefix`. */
  keys(prefix: string): Promise<string[]>;
  removeByPrefix(prefix: string): Promise<void>;
}

/**
 * A migration to a specific schema version. Receives whatever the previous
 * version stored — necessarily `unknown`, because the old shape is no longer
 * expressible in current types — and returns the next version's shape.
 *
 * Migrations must be **pure and total**: no I/O, and no throwing for data they
 * are expected to handle. A throw is treated as "this record is unreadable",
 * which is safe but means the user stops seeing that record.
 */
export type Migration = (previous: unknown) => unknown;

export interface StoreConfig<T> {
  /** Key segment, e.g. "library". Must not contain the `:` separator. */
  namespace: string;
  /** Current schema version. Starts at 1 and only ever increases. */
  version: number;
  /**
   * Keyed by **target** version: `migrations[3]` upgrades a v2 record to v3.
   * Migrating v1 -> v3 runs `migrations[2]` then `migrations[3]`.
   *
   * These can never be deleted. Records migrate lazily on read, so a value
   * written at v1 can still be sitting in a user's browser years later.
   */
  migrations?: Record<number, Migration>;
  /**
   * Optional post-migration shape check. A record failing this is treated as
   * unreadable rather than handed to the app as the wrong type — cheap
   * insurance against a migration bug or hand-edited localStorage.
   */
  validate?: (data: unknown) => data is T;
}

export interface Store<T> {
  readonly namespace: string;
  get(key: string): Promise<T | null>;
  /** Every readable record in this namespace, keyed without the prefix. */
  getAll(): Promise<Record<string, T>>;
  keys(): Promise<string[]>;
  /** Rejects with `StorageError` — see the note on write failure in CLAUDE.md. */
  set(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Removes only this namespace's keys, never another feature's. */
  clear(): Promise<void>;
}
