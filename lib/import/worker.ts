/// <reference lib="webworker" />

import { parseImportFile, type ParseResult } from "./parse-file";

/**
 * The import parser, off the main thread.
 *
 * ============================================================================
 * WHAT IS ACTUALLY EXPENSIVE HERE
 * ============================================================================
 * Not the CSV parse, which is milliseconds even for a large export. The two
 * costs worth moving are:
 *
 *   - `importIdFor`, a SHA-1 over every byte of the file in plain JavaScript
 *     (plain JS because `crypto.subtle` is secure-context only — see
 *     lib/sync/uuid.ts). On a multi-megabyte export that is real work.
 *   - ZIP inflation of every CSV in a Letterboxd export.
 *
 * Together those are enough to visibly jank a page, and they land at exactly
 * the moment the user has just dropped a file and is watching for a response.
 *
 * Network resolution deliberately stays on the main thread: it is I/O-bound,
 * not CPU-bound, and it needs to drive a progress bar. Moving it here would
 * buy nothing and cost a message round trip per batch.
 *
 * This file is a transport only. Every decision lives in `parse-file.ts`,
 * which is a plain function the main-thread fallback calls directly.
 */

export interface ParseRequest {
  fileName: string;
  buffer: ArrayBuffer;
}

export type ParseResponse =
  | { ok: true; result: ParseResult }
  | { ok: false; message: string };

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  const { fileName, buffer } = event.data;

  parseImportFile(fileName, buffer)
    .then((result) => {
      const response: ParseResponse = { ok: true, result };
      self.postMessage(response);
    })
    .catch((error: unknown) => {
      // Only the message crosses back. A structured-clone failure on some
      // exotic Error subclass would surface as a worker crash with no
      // explanation, which is a far worse failure than a plain string.
      const response: ParseResponse = {
        ok: false,
        message: error instanceof Error ? error.message : "Could not read that file.",
      };
      self.postMessage(response);
    });
});
