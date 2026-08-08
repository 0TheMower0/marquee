import { uuidV5 } from "@/lib/sync/uuid";

import type { ImportRow } from "./types";

/**
 * Deterministic identifiers for an import.
 *
 * ============================================================================
 * WHY THE FILE'S CONTENT IS THE IDENTITY
 * ============================================================================
 * `importId` is derived from the file's BYTES, not from a timestamp or a
 * random value. Re-selecting the same export therefore produces the same id,
 * which is what lets the app say *"you imported this file on 12 August"*
 * instead of silently doubling a user's history — the single most likely way
 * an importer damages someone's data.
 *
 * It is a hash of content, so it is stable across devices and across
 * sessions, and it changes the moment the file does (a fresh export with one
 * new row is a genuinely different import).
 */

/** SHA-1 via `uuidV5`, which uses the plain-JS implementation in
 *  `lib/sync/uuid.ts` unconditionally. That matters here for the same reason
 *  it mattered there: `crypto.subtle` is secure-context only, so a
 *  subtle-backed hash would derive DIFFERENT ids on a plain-HTTP origin, and
 *  these ids are watch-log primary keys. One implementation, everywhere. */
export function importIdFor(fileBytes: Uint8Array): Promise<string> {
  // Hashing a latin1 view of the bytes rather than decoding as UTF-8: a CSV
  // may contain invalid UTF-8, and a lossy decode would map two different
  // files onto the same id.
  let binary = "";
  for (let i = 0; i < fileBytes.length; i += 1) binary += String.fromCharCode(fileBytes[i]);
  return uuidV5(`import-file:${binary}`);
}

/**
 * The id for a watch event created by an import — **signed-in only**.
 *
 * ============================================================================
 * WHY THIS TAKES A userId, AND WHY THERE IS NO SIGNED-OUT VARIANT
 * ============================================================================
 * `userId` is in the name for exactly the reason `preAccountEventId` gives:
 * without it, two different accounts importing the same export would derive
 * identical ids, and one of them would lose events to the other's rows.
 *
 * With it, the same user importing the same file on a second device derives
 * the SAME ids, so the server's insert dedupes instead of duplicating a
 * decade of viewing history. That cross-device property is the whole reason
 * this is deterministic rather than random.
 *
 * Signed out there is no `userId` and therefore no honest way to derive a
 * stable id — so imported events are appended with no id at all, exactly like
 * every other watch-log write made while signed out. The established
 * first-login merge then assigns them `preAccountEventId(userId, dayKey,
 * index)`, which is already the tested path. Import idempotency in that state
 * comes from the import JOB record instead: the same file is recognized and
 * refused before any row is written.
 *
 * `sourceRowId` carries the source and line number, so two diary rows for the
 * same film on the same date stay distinct — the same reason
 * `preAccountEventId` keys on an array index rather than on event content.
 */
export function importEventId(
  userId: string,
  importId: string,
  row: ImportRow,
): Promise<string> {
  return uuidV5(`import-event:${userId}:${importId}:${row.sourceRowId}`);
}
