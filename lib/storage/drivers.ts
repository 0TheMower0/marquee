import { StorageError, type StorageDriver, type StorageStatus } from "./types";

/**
 * Driver implementations and the selection logic between them.
 *
 * Three environments have to work:
 *
 * 1. Browser, storage available      -> localStorageDriver (persists)
 * 2. Browser, storage blocked/full   -> memoryDriver (session only)
 * 3. No browser at all (SSR)         -> nullDriver (reads null, drops writes)
 *
 * Case 3 must NOT be the memory driver. A module-level Map on the server is
 * shared across every request, so one visitor's writes would be readable by
 * the next — a genuine data leak, not just a correctness wrinkle. Reading
 * nothing during SSR is also simply correct: the server has no access to this
 * user's localStorage, so the honest initial render is "no saved data".
 */

/**
 * Firefox and older WebKit report quota exhaustion with their own names and
 * legacy numeric codes rather than the standard `QuotaExceededError`.
 */
function isQuotaError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22 ||
    error.code === 1014
  );
}

function keysWithPrefix(storage: Storage, prefix: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) found.push(key);
  }
  return found;
}

function createLocalStorageDriver(storage: Storage): StorageDriver {
  return {
    status: "persistent",

    async get(key) {
      try {
        return storage.getItem(key);
      } catch (cause) {
        // Storage can be revoked mid-session (permission change, eviction).
        // A read failure degrades to "no data", never to a thrown error.
        console.warn("[storage] read failed:", key, cause);
        return null;
      }
    },

    async set(key, value) {
      try {
        storage.setItem(key, value);
      } catch (cause) {
        if (isQuotaError(cause)) {
          throw new StorageError(
            "quota_exceeded",
            "Browser storage is full. The change was not saved.",
            { cause },
          );
        }
        throw new StorageError(
          "unknown",
          "Browser storage rejected the write.",
          { cause },
        );
      }
    },

    async remove(key) {
      try {
        storage.removeItem(key);
      } catch (cause) {
        console.warn("[storage] remove failed:", key, cause);
      }
    },

    async keys(prefix) {
      try {
        return keysWithPrefix(storage, prefix);
      } catch (cause) {
        console.warn("[storage] key enumeration failed:", cause);
        return [];
      }
    },

    async removeByPrefix(prefix) {
      try {
        // Collected first: removing while iterating by index reshuffles the
        // remaining indices and silently skips entries.
        for (const key of keysWithPrefix(storage, prefix)) {
          storage.removeItem(key);
        }
      } catch (cause) {
        console.warn("[storage] prefix clear failed:", prefix, cause);
      }
    },
  };
}

function createMemoryDriver(status: StorageStatus): StorageDriver {
  const map = new Map<string, string>();
  return {
    status,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
    async removeByPrefix(prefix) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}

const nullDriver: StorageDriver = {
  status: "unavailable",
  async get() {
    return null;
  },
  async set() {
    // Silently discarded on purpose. Throwing during SSR would break the
    // render for a write the app can legitimately retry after hydration.
  },
  async remove() {},
  async keys() {
    return [];
  },
  async removeByPrefix() {},
};

const PROBE_KEY = "__marquee_probe__";

function detectDriver(): StorageDriver {
  if (typeof window === "undefined") return nullDriver;

  try {
    const storage = window.localStorage;
    // Merely accessing `localStorage` throws in some blocked-cookie
    // configurations, and Safari private mode historically allowed access but
    // threw on write — so the probe has to be a real round trip, not a
    // truthiness check.
    storage.setItem(PROBE_KEY, PROBE_KEY);
    storage.removeItem(PROBE_KEY);
    return createLocalStorageDriver(storage);
  } catch (cause) {
    console.warn(
      "[storage] localStorage unavailable, falling back to memory. Data will not persist.",
      cause,
    );
    return createMemoryDriver("memory");
  }
}

let cached: StorageDriver | null = null;

/**
 * Resolved lazily and cached. Lazy matters: this module gets imported into
 * Client Components that also render on the server, and probing localStorage
 * at import time would run in the wrong environment.
 */
export function getDriver(): StorageDriver {
  cached ??= detectDriver();
  return cached;
}

export function getStorageStatus(): StorageStatus {
  return getDriver().status;
}

/** Test seam — lets a suite install a known driver. Not for app code. */
export function __setDriverForTesting(driver: StorageDriver | null): void {
  cached = driver;
}
