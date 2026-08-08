/**
 * A minimal ZIP reader, because a Letterboxd account export downloads as a
 * `.zip` and telling someone to unzip it first is exactly the friction that
 * makes people not bother switching.
 *
 * ============================================================================
 * WHY THIS NEEDS NO DEPENDENCY
 * ============================================================================
 * The container format is simple — a table of contents at the end of the file
 * pointing at each entry — and the only compression method any real export
 * uses is DEFLATE, which the platform already implements as
 * `DecompressionStream("deflate-raw")`. So the ~100 lines here are structure
 * parsing, not compression. Nothing about DEFLATE itself is reimplemented.
 *
 * Scope, stated so nobody expects more of it: no ZIP64 (a Letterboxd export is
 * kilobytes, not gigabytes), no encryption, no multi-disk archives, and no
 * CP437 filename fallback. Every one of those returns a clear failure rather
 * than a wrong answer.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

/** End-of-central-directory record, without its variable-length comment. */
const EOCD_SIZE = 22;
const CENTRAL_FILE_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  /** Uncompressed size as declared in the central directory. Lets a caller
   *  skip an implausibly large entry without inflating it first. */
  size: number;
  /** Inflates and decodes this entry. **Lazy on purpose** — an export
   *  contains files this importer has no use for (`reviews.csv`,
   *  `comments.csv`, a `lists/` folder), and inflating them all to read two
   *  would be wasted work on the user's device. */
  text(): Promise<string>;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError("This browser cannot decompress ZIP files.");
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Locates the end-of-central-directory record.
 *
 * Scanned BACKWARD from the end rather than seeked to directly, because the
 * record is followed by a variable-length comment field of up to 64KB, so its
 * position is not fixed. The scan is bounded to that maximum so a corrupt file
 * cannot turn this into a full-buffer search.
 */
function findEocd(view: DataView): number {
  const maxCommentLength = 0xffff;
  const earliest = Math.max(0, view.byteLength - EOCD_SIZE - maxCommentLength);
  for (let offset = view.byteLength - EOCD_SIZE; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("Not a ZIP file, or the archive is truncated.");
}

/**
 * Reads an archive's table of contents.
 *
 * Entry data is NOT read here — only the directory. `text()` on a returned
 * entry does the actual work.
 */
export async function readZip(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  if (buffer.byteLength < EOCD_SIZE) throw new ZipError("File is too small to be a ZIP.");

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);

  const entryCount = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  // A ZIP64 archive writes sentinel values here rather than real ones. We do
  // not support it, and saying so beats reading a nonsense offset.
  if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipError("ZIP64 archives are not supported.");
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + CENTRAL_FILE_HEADER_SIZE > buffer.byteLength) {
      throw new ZipError("Archive directory is truncated.");
    }
    if (view.getUint32(cursor, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new ZipError("Archive directory is corrupt.");
    }

    const method = view.getUint16(cursor + 10, true);
    // Sizes are taken from the CENTRAL directory, never the local header: when
    // an archiver streams output it sets the local header's sizes to zero and
    // writes the real values to a trailing data descriptor. The central
    // directory is always correct.
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);

    const name = decoder.decode(
      bytes.subarray(cursor + CENTRAL_FILE_HEADER_SIZE, cursor + CENTRAL_FILE_HEADER_SIZE + nameLength),
    );

    cursor += CENTRAL_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;

    // Directory entries carry no data.
    if (name.endsWith("/")) continue;

    entries.push({
      name,
      size: uncompressedSize,
      async text() {
        if (view.getUint32(localOffset, true) !== LOCAL_FILE_SIGNATURE) {
          throw new ZipError(`Entry "${name}" is corrupt.`);
        }
        // The local header's own name/extra lengths are read again rather than
        // reused from the central directory: the extra field legitimately
        // differs between the two, and using the wrong one lands the data
        // offset in the middle of a header.
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + LOCAL_FILE_HEADER_SIZE + localNameLength + localExtraLength;
        const raw = bytes.subarray(start, start + compressedSize);

        if (method === METHOD_STORED) return decoder.decode(raw);
        if (method === METHOD_DEFLATE) return decoder.decode(await inflateRaw(raw));
        throw new ZipError(`Entry "${name}" uses an unsupported compression method.`);
      },
    });
  }

  return entries;
}

/** Whether a byte buffer starts with a local-file-header signature — the
 *  cheap check that lets the UI route a dropped file to the ZIP path or the
 *  CSV path without trusting its extension. */
export function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === LOCAL_FILE_SIGNATURE;
}

/** CSV entries only, skipping macOS resource forks — a ZIP made on a Mac
 *  carries a `__MACOSX/` shadow of every file, and reading those as data
 *  produces garbage rows the user cannot explain. */
export function csvEntries(entries: readonly ZipEntry[]): ZipEntry[] {
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().endsWith(".csv") &&
      !entry.name.startsWith("__MACOSX/") &&
      !entry.name.split("/").pop()?.startsWith("."),
  );
}
