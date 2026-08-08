import { describe, expect, it } from "vitest";

import { ZipError, csvEntries, looksLikeZip, readZip } from "./zip";

/**
 * Archives are BUILT here rather than committed as binary fixtures: a
 * checked-in .zip is opaque in review, and a test whose input nobody can read
 * is a test nobody can correct. Building them also lets each case isolate one
 * structural quirk (a comment, a data descriptor, a __MACOSX shadow).
 */

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

interface BuildEntry {
  name: string;
  content: string;
  /** Written into the LOCAL header only, to simulate a streaming archiver
   *  that defers real sizes to a data descriptor. */
  zeroLocalSizes?: boolean;
  /** Bytes of junk in the local header's extra field but not the central
   *  directory's — the case that catches reusing the wrong extra length. */
  localExtra?: number;
}

/** Builds a STORED (uncompressed) archive. Compression is the platform's job,
 *  not this module's, so the structure parsing is what these tests exercise. */
function buildZip(entries: BuildEntry[], comment = ""): ArrayBuffer {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const extra = entry.localExtra ?? 0;

    const local = new Uint8Array(30 + name.length + extra);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc32(data), true);
    localView.setUint32(18, entry.zeroLocalSizes ? 0 : data.length, true);
    localView.setUint32(22, entry.zeroLocalSizes ? 0 : data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, extra, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(10, 0, true); // stored
    headerView.setUint32(16, crc32(data), true);
    headerView.setUint32(20, data.length, true); // central sizes are ALWAYS real
    headerView.setUint32(24, data.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true); // no extra in the central directory
    headerView.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }

  const directoryOffset = offset;
  const directorySize = central.reduce((sum, h) => sum + h.length, 0);
  const commentBytes = encoder.encode(comment);

  const eocd = new Uint8Array(22 + commentBytes.length);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, directoryOffset, true);
  eocdView.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);

  const total = [...parts, ...central, eocd];
  const size = total.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of total) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

describe("readZip", () => {
  it("lists entries and reads their content", async () => {
    const zip = buildZip([
      { name: "diary.csv", content: "Date,Name\n2019-01-01,Gravity" },
      { name: "ratings.csv", content: "Date,Name\n2019-01-02,Heat" },
    ]);
    const entries = await readZip(zip);

    expect(entries.map((e) => e.name)).toEqual(["diary.csv", "ratings.csv"]);
    expect(await entries[0].text()).toBe("Date,Name\n2019-01-01,Gravity");
    expect(await entries[1].text()).toBe("Date,Name\n2019-01-02,Heat");
  });

  it("reports the declared uncompressed size without reading the entry", async () => {
    const entries = await readZip(buildZip([{ name: "a.csv", content: "hello" }]));
    expect(entries[0].size).toBe(5);
  });

  it("finds the directory past a trailing archive comment", async () => {
    // The EOCD is not at a fixed offset — a comment pushes it back, which is
    // why the reader scans rather than seeks.
    const zip = buildZip([{ name: "a.csv", content: "x" }], "created by something");
    expect((await readZip(zip)).map((e) => e.name)).toEqual(["a.csv"]);
  });

  it("trusts the CENTRAL directory's sizes when the local header says zero", async () => {
    // A streaming archiver writes zeroes locally and the real sizes to a
    // trailing data descriptor. Reading the local values would return nothing.
    const zip = buildZip([{ name: "a.csv", content: "real content", zeroLocalSizes: true }]);
    expect(await (await readZip(zip))[0].text()).toBe("real content");
  });

  it("reads the LOCAL header's extra length, not the central one", async () => {
    // These legitimately differ. Using the central directory's value here
    // lands the data offset inside the header and returns shifted garbage.
    const zip = buildZip([{ name: "a.csv", content: "aligned", localExtra: 9 }]);
    expect(await (await readZip(zip))[0].text()).toBe("aligned");
  });

  it("skips directory entries", async () => {
    const zip = buildZip([
      { name: "lists/", content: "" },
      { name: "lists/watched.csv", content: "x" },
    ]);
    expect((await readZip(zip)).map((e) => e.name)).toEqual(["lists/watched.csv"]);
  });

  it("rejects a file that is not a ZIP", async () => {
    await expect(readZip(encoder.encode("Const,Title\ntt1,X").buffer as ArrayBuffer)).rejects.toBeInstanceOf(
      ZipError,
    );
  });

  it("rejects a file too small to contain a directory", async () => {
    await expect(readZip(new ArrayBuffer(4))).rejects.toBeInstanceOf(ZipError);
  });

  it("reports corruption rather than returning wrong data", async () => {
    const zip = buildZip([{ name: "a.csv", content: "x" }]);
    const view = new DataView(zip);
    // The directory offset is read from the EOCD rather than computed: a
    // central header is `46 + nameLength` bytes, so any arithmetic guess here
    // lands mid-header and corrupts a field the reader never validates —
    // which makes the test pass for the wrong reason, or not at all.
    const directoryOffset = view.getUint32(zip.byteLength - 22 + 16, true);
    view.setUint32(directoryOffset, 0xdeadbeef, true);

    await expect(readZip(zip)).rejects.toBeInstanceOf(ZipError);
  });
});

describe("deflate entries", () => {
  it("inflates a DEFLATE entry using the platform decompressor", async () => {
    if (typeof CompressionStream === "undefined") return; // environment lacks it

    const content = "Date,Name,Year\n".repeat(50);
    const raw = encoder.encode(content);
    const compressed = new Uint8Array(
      await new Response(
        new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );

    const name = encoder.encode("diary.csv");
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, 8, true); // deflate
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(10, 8, true); // deflate
    headerView.setUint32(20, compressed.length, true);
    headerView.setUint32(24, raw.length, true);
    headerView.setUint16(28, name.length, true);
    header.set(name, 46);

    const directoryOffset = local.length + compressed.length;
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, 1, true);
    eocdView.setUint16(10, 1, true);
    eocdView.setUint32(12, header.length, true);
    eocdView.setUint32(16, directoryOffset, true);

    const out = new Uint8Array(directoryOffset + header.length + eocd.length);
    out.set(local, 0);
    out.set(compressed, local.length);
    out.set(header, directoryOffset);
    out.set(eocd, directoryOffset + header.length);

    const entries = await readZip(out.buffer);
    expect(await entries[0].text()).toBe(content);
  });
});

describe("looksLikeZip", () => {
  it("recognizes a ZIP by its signature rather than its extension", () => {
    expect(looksLikeZip(buildZip([{ name: "a.csv", content: "x" }]))).toBe(true);
    expect(looksLikeZip(encoder.encode("Date,Name\n").buffer as ArrayBuffer)).toBe(false);
    expect(looksLikeZip(new ArrayBuffer(2))).toBe(false);
  });
});

describe("csvEntries", () => {
  it("keeps only CSVs, and drops macOS resource-fork shadows", async () => {
    // A ZIP made on a Mac carries a __MACOSX/ shadow of every file; reading
    // those as data produces garbage rows the user cannot explain.
    const entries = await readZip(
      buildZip([
        { name: "diary.csv", content: "a" },
        { name: "profile.json", content: "{}" },
        { name: "__MACOSX/._diary.csv", content: "junk" },
        { name: ".DS_Store", content: "junk" },
      ]),
    );
    expect(csvEntries(entries).map((e) => e.name)).toEqual(["diary.csv"]);
  });
});
