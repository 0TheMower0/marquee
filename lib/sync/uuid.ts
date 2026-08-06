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

/** Random v4, for events created while signed in. */
export function randomUuid(): string {
  return crypto.randomUUID();
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
 * RFC 4122 v5: SHA-1 over (namespace bytes || name bytes), with the version
 * and variant bits overwritten.
 *
 * SHA-1 is correct here and is not a security decision — v5 is *defined* as
 * SHA-1, and this is a naming scheme, not a signature. Nothing about the
 * output is required to be unpredictable; it is required to be *reproducible*,
 * which is the opposite property.
 *
 * Async because `crypto.subtle.digest` is. That propagates up through the
 * merge, which is fine — the merge is already an awaited pipeline.
 */
export async function uuidV5(name: string, namespace = MARQUEE_UUID_NAMESPACE): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);

  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);

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
