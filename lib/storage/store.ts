import { getDriver } from "./drivers";
import { decode, encode } from "./serialize";
import {
  StorageError,
  type Migration,
  type Store,
  type StoreConfig,
} from "./types";

/**
 * Namespaced, versioned, migrating key-value store.
 *
 * ============================================================================
 * WHY MIGRATION IS LAZY AND PER-RECORD
 * ============================================================================
 * The obvious design is an eager pass: on first access, read every record in
 * the namespace, upgrade them all, write them back, bump a stored version
 * number. It is rejected here for one decisive reason: **localStorage has no
 * transactions.** A user closing the tab midway through leaves the namespace
 * half-migrated with no record of how far it got, and the next load cannot
 * tell upgraded records from stale ones. That is exactly the "users lose their
 * library" failure this layer exists to prevent.
 *
 * Instead each record carries its own version in an envelope, and is upgraded
 * on read. Every record is therefore *independently* either old or new, both
 * of which are readable. An interrupted session loses nothing. There is no
 * migration-in-progress state to be crash-consistent about, because there is
 * no such state.
 *
 * The costs of this choice, stated plainly:
 *
 * - **Migrations can never be deleted.** A record written at v1 may still be
 *   sitting in a browser years later, so `migrations[2]` must survive forever.
 * - **Cross-record migrations are not expressible.** Splitting one key into
 *   several, or deduplicating across records, needs to see the whole namespace
 *   at once. If Phase 3 needs that, do it as an explicit one-off routine over
 *   `getAll()` at a higher layer — do not try to smuggle it into a per-record
 *   migration, which sees exactly one value and cannot write others.
 *
 * ============================================================================
 * ROLLBACK SAFETY
 * ============================================================================
 * A record whose version is *higher* than the code's is refused, not coerced.
 * This happens for real: a user opens a cached older deployment, or we roll
 * back a bad release. Downgrading data we do not understand would destroy it
 * permanently. Refusing to read means that feature looks empty on the old
 * build and comes back intact on the new one.
 */

const KEY_ROOT = "marquee";
const SEPARATOR = ":";

interface Envelope {
  /** Schema version this record was written at. */
  v: number;
  /** The payload. `unknown` until migrated and validated. */
  d: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Envelope).v === "number" &&
    "d" in value
  );
}

function runMigrations(
  from: number,
  to: number,
  migrations: Record<number, Migration> | undefined,
  data: unknown,
): unknown {
  let current = data;
  for (let target = from + 1; target <= to; target += 1) {
    const migration = migrations?.[target];
    if (!migration) {
      throw new Error(
        `No migration registered for version ${target}; cannot upgrade from ${from} to ${to}.`,
      );
    }
    current = migration(current);
  }
  return current;
}

export function defineStore<T>(config: StoreConfig<T>): Store<T> {
  const { namespace, version, migrations, validate } = config;

  if (namespace.includes(SEPARATOR)) {
    // Would let one namespace's keys masquerade as another's.
    throw new Error(
      `Storage namespace "${namespace}" must not contain "${SEPARATOR}".`,
    );
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Storage version for "${namespace}" must be an integer >= 1.`);
  }

  // NOTE: the version is deliberately NOT part of the key. Putting it there
  // would orphan every existing record the moment the version is bumped —
  // which is the precise opposite of a migration path.
  const prefix = `${KEY_ROOT}${SEPARATOR}${namespace}${SEPARATOR}`;
  const fullKey = (key: string) => `${prefix}${key}`;
  const shortKey = (key: string) => key.slice(prefix.length);

  async function write(key: string, value: T): Promise<void> {
    const envelope: Envelope = { v: version, d: value };
    // encode() throws StorageError('serialization') on its own; let it through
    // rather than mislabelling a bad value as a storage failure.
    await getDriver().set(fullKey(key), encode(envelope));
  }

  async function read(key: string): Promise<T | null> {
    const raw = await getDriver().get(fullKey(key));
    if (raw === null) return null;

    let envelope: unknown;
    try {
      envelope = decode<unknown>(raw);
    } catch (error) {
      console.warn(`[storage] ${namespace}/${key}: unparseable, ignoring.`, error);
      return null;
    }

    if (!isEnvelope(envelope)) {
      console.warn(`[storage] ${namespace}/${key}: not a versioned record, ignoring.`);
      return null;
    }

    if (envelope.v > version) {
      console.warn(
        `[storage] ${namespace}/${key}: written by a newer schema (v${envelope.v} > v${version}). ` +
          `Refusing to read so the data survives a rollback.`,
      );
      return null;
    }

    let data = envelope.d;

    if (envelope.v < version) {
      try {
        data = runMigrations(envelope.v, version, migrations, data);
      } catch (error) {
        // The original stays on disk untouched — a migration bug should be
        // fixable by shipping a corrected migration, not a data-loss event.
        console.warn(
          `[storage] ${namespace}/${key}: migration v${envelope.v} -> v${version} failed, ignoring record.`,
          error,
        );
        return null;
      }

      if (validate && !validate(data)) {
        console.warn(
          `[storage] ${namespace}/${key}: failed validation after migration, ignoring.`,
        );
        return null;
      }

      // Opportunistic write-back so the migration is paid for once rather than
      // on every read. Best-effort by design: if this fails (quota, storage
      // revoked) the caller still gets correctly migrated data, and the record
      // is simply migrated again next time.
      void getDriver()
        .set(fullKey(key), encode({ v: version, d: data } satisfies Envelope))
        .catch(() => {});

      return data as T;
    }

    if (validate && !validate(data)) {
      console.warn(`[storage] ${namespace}/${key}: failed validation, ignoring.`);
      return null;
    }

    return data as T;
  }

  return {
    namespace,

    get: read,

    async getAll() {
      const driver = getDriver();
      const found = await driver.keys(prefix);
      const entries = await Promise.all(
        found.map(async (key) => {
          const short = shortKey(key);
          return [short, await read(short)] as const;
        }),
      );

      const result: Record<string, T> = {};
      for (const [key, value] of entries) {
        // Unreadable records are skipped, not surfaced as null — callers
        // asking for "everything" want everything usable.
        if (value !== null) result[key] = value;
      }
      return result;
    },

    async keys() {
      return (await getDriver().keys(prefix)).map(shortKey);
    },

    set: write,

    async remove(key) {
      await getDriver().remove(fullKey(key));
    },

    async clear() {
      // Prefix-scoped: clearing the library must never touch another
      // namespace, and must never call localStorage.clear(), which would also
      // wipe anything else on the origin.
      await getDriver().removeByPrefix(prefix);
    },
  };
}

export { StorageError };
