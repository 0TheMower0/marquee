/**
 * UUID generation for `watch_events`.
 *
 * Pure apart from `crypto`, no storage, no React — so it carries tests. This
 * is the single most load-bearing file for the "just run the merge again"
 * recovery strategy, and design doc §6.2 says why:
 *
 * > If the merge minted a random v4 UUID per event, a retried merge would mint
 * > *different* UUIDs for the same events and insert every one of them a
 * > second time. The append-only log would silently double, `hasRepeatedMark`
 * > would start reporting rewatches that never happened, and the "just run it
 * > again" recovery strategy would be actively destructive.
 *
 * So there are two paths, and which one applies is decided by whether the
 * event already carries an id:
 *
 *   - Events written AFTER sign-in get a v4 at write time, persisted locally
 *     alongside the event. The id exists before the row ever reaches the
 *     outbox, so a retry re-sends the same id.
 *   - Events written BEFORE the account existed have no id and never will
 *     have one stored. They get a **deterministic v5** derived from
 *     `(userId, dayKey, index)`, recomputed identically on every merge attempt.
 */

/**
 * The Marquee namespace UUID. A fixed, arbitrary v4 generated once for this
 * purpose.
 *
 * It must never change. Changing it re-derives every pre-account event id,
 * and a subsequent merge would insert the entire pre-account history a second
 * time under new ids — the exact failure the determinism exists to prevent.
 */
export const MARQUEE_UUID_NAMESPACE = "6f1d4f2a-3b7c-4e58-9a21-0c5e8d3b7f04";

/**
 * Random v4, for events created while signed in.
 *
 * ============================================================================
 * WHY NOT JUST `crypto.randomUUID()`
 * ============================================================================
 * `Crypto.randomUUID()` is **secure-context only**. On `https://` and on
 * `localhost` it exists; on a plain-HTTP origin — `http://192.168.1.112:3000`,
 * which is how you reach a dev server from a phone on the same network, and
 * how any non-HTTPS deployment is reached — it is `undefined`, and calling it
 * throws `TypeError: crypto.randomUUID is not a function`.
 *
 * That threw out of `appendWatchEvents` *before* its try block, so on an
 * insecure origin every watch-log append rejected: no event recorded, no sync
 * row queued. Silently, because the call site is `void appendWatchEvents(...)`.
 *
 * `crypto.getRandomValues` is NOT secure-context gated, so the fallback is a
 * real v4 with real randomness rather than a degraded one.
 */
export function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether a string is a syntactically valid RFC 4122 UUID with a correct
 *  variant nibble. Used to reject a locally-stored id that has been corrupted
 *  or hand-edited, rather than sending it to Postgres and taking a 22P02. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * SHA-1, in plain JavaScript.
 *
 * ============================================================================
 * WHY THIS IS NOT `crypto.subtle.digest("SHA-1", ...)`
 * ============================================================================
 * `SubtleCrypto` is **secure-context only** — `crypto.subtle` is `undefined` on
 * a plain-HTTP origin, so the original implementation threw
 * `TypeError: Cannot read properties of undefined (reading 'digest')` and the
 * first-login merge failed outright for anyone not on HTTPS or localhost.
 *
 * The tempting fix is "use subtle when available, fall back to this
 * otherwise". **That would be worse than either option alone.** These ids are
 * the primary keys of watch-log rows, and the entire "just run the merge
 * again" recovery strategy depends on the same input producing the same id
 * *everywhere* — including across two devices where one is on HTTPS and the
 * other is not. Two implementations of one critical value is exactly how a
 * subtle divergence gets shipped, and the symptom would be the user's whole
 * pre-account history inserted a second time under different ids.
 *
 * So there is one implementation, used unconditionally, pinned by the
 * published RFC 4122 test vector. SHA-1 here is a naming scheme, not a
 * signature — nothing about the output must be unpredictable, only
 * reproducible — so using a hand-rolled implementation carries no security
 * weight.
 *
 * Being synchronous is a bonus: it removes the only reason `uuidV5` had to be
 * async. The signature stays async anyway, because the merge already awaits it
 * and changing it would churn every caller for no gain.
 */
function sha1(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const blocks = Math.ceil((input.length + 9) / 64);
  const total = blocks * 64;

  const message = new Uint8Array(total);
  message.set(input);
  message[input.length] = 0x80;

  const view = new DataView(message.buffer);
  // 64-bit big-endian length. The high word is written separately because a
  // single setUint32 cannot express lengths past 2^32 bits, and JS bitwise ops
  // would silently truncate.
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(total - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

/**
 * RFC 4122 v5: SHA-1 over (namespace bytes || name bytes), with the version
 * and variant bits overwritten.
 */
export async function uuidV5(name: string, namespace = MARQUEE_UUID_NAMESPACE): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);

  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const bytes = sha1(input).slice(0, 16);

  // Version 5 in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // RFC 4122 variant in the top two bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

/**
 * The id for a pre-account watch-log event.
 *
 * ============================================================================
 * WHY THE ARRAY INDEX, AND NOT THE EVENT'S CONTENT
 * ============================================================================
 * Hashing content — kind, title, season, episode — looks tidier and is wrong.
 * Two genuine marks of the same episode on the same day would hash to one id
 * and collapse into a single row, destroying exactly the signal the "Second
 * Helping" badge reads (`hasRepeatedMark` detects an unmark-then-remark as a
 * duplicate tuple in the log). The index is what keeps real duplicates
 * distinct.
 *
 * This is safe only because **the log is append-only**: `appendWatchEvents`
 * concatenates onto the end of a day's array and nothing ever removes,
 * reorders, or rewrites an entry. So the index of an existing event is stable
 * across retries, and a new event appended after a merge takes a fresh index
 * that was never used.
 *
 * `userId` is in the name so two accounts merging the same exported data
 * cannot produce colliding ids.
 */
export function preAccountEventId(
  userId: string,
  dayKey: string,
  index: number,
): Promise<string> {
  return uuidV5(`watch-event:${userId}:${dayKey}:${index}`);
}
