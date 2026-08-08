import { describe, expect, it } from "vitest";

import { parseImportFile, resolveAmbiguous } from "./parse-file";

const encoder = new TextEncoder();

function file(text: string): ArrayBuffer {
  return encoder.encode(text).buffer as ArrayBuffer;
}

const IMDB_RATINGS =
  "Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors\n" +
  "tt0068646,10,2020-05-04,The Godfather,url,movie,9.2,175,1972,Crime,2000000,1972-03-24,Coppola";

/** Headers identical to watched.csv — unresolvable without a filename. */
const LB_MINIMAL = "Date,Name,Year,Letterboxd URI\n2019-03-20,Gravity,2013,https://letterboxd.com/film/gravity-2013/";

describe("parseImportFile", () => {
  it("parses a loose CSV and derives a content-based id", async () => {
    const result = await parseImportFile("ratings.csv", file(IMDB_RATINGS));

    expect(result.files).toHaveLength(1);
    expect(result.files[0].source).toBe("imdb-ratings");
    expect(result.files[0].rows[0].imdbId).toBe("tt0068646");
    expect(result.importId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("derives the SAME id for identical bytes and a different one otherwise", async () => {
    // The property the repeat-import guard depends on.
    const a = await parseImportFile("a.csv", file(IMDB_RATINGS));
    const b = await parseImportFile("renamed.csv", file(IMDB_RATINGS));
    const c = await parseImportFile("a.csv", file(`${IMDB_RATINGS}\n`));

    expect(a.importId).toBe(b.importId);
    expect(a.importId).not.toBe(c.importId);
  });

  it("reports an unrecognized file by name instead of returning zero rows", async () => {
    const result = await parseImportFile("budget.csv", file("a,b\n1,2"));
    expect(result.files).toEqual([]);
    expect(result.unrecognized).toEqual(["budget.csv"]);
  });

  it("resolves watchlist/watched from the filename when it is informative", async () => {
    const result = await parseImportFile("watchlist.csv", file(LB_MINIMAL));
    expect(result.files[0].source).toBe("letterboxd-watchlist");
    expect(result.ambiguous).toEqual([]);
  });

  it("defers to the user when the filename is NOT informative", async () => {
    const result = await parseImportFile("export (1).csv", file(LB_MINIMAL));
    expect(result.files).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].choices).toEqual([
      "letterboxd-watchlist",
      "letterboxd-watched",
    ]);
  });

  it("applies the user's answer without re-reading the file", () => {
    const ambiguous = {
      fileName: "export (1).csv",
      text: LB_MINIMAL,
      choices: ["letterboxd-watchlist", "letterboxd-watched"] as const,
    };

    const asWatched = resolveAmbiguous(ambiguous, "letterboxd-watched");
    expect(asWatched.rows[0].intent).toBe("watched");

    const asWatchlist = resolveAmbiguous(ambiguous, "letterboxd-watchlist");
    expect(asWatchlist.rows[0].intent).toBe("watchlist");
  });
});

describe("ParseResult crosses a Worker boundary", () => {
  /**
   * ============================================================================
   * THE REGRESSION THIS EXISTS FOR
   * ============================================================================
   * `AmbiguousFile` originally carried the parsed `CsvTable`, whose
   * `CsvRecord`s expose `get`/`has` as METHODS. Functions are not
   * structured-cloneable, so `worker.postMessage` threw
   * "…could not be cloned" — and only ever for an ambiguous file, which is
   * precisely the case the type exists to handle.
   *
   * Every module involved was individually correct and fully tested; the
   * failure lived only at the boundary between them, and only live testing
   * found it. `structuredClone` is the same algorithm `postMessage` uses, so
   * asserting on it here reproduces the exact constraint without a worker.
   */
  it("survives structuredClone for a plain file", async () => {
    const result = await parseImportFile("ratings.csv", file(IMDB_RATINGS));
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("survives structuredClone for an AMBIGUOUS file — the case that broke", async () => {
    const result = await parseImportFile("export (1).csv", file(LB_MINIMAL));
    expect(result.ambiguous).toHaveLength(1);
    expect(() => structuredClone(result)).not.toThrow();
  });

  it("round-trips to an equal value, not merely a cloneable one", async () => {
    const result = await parseImportFile("export (1).csv", file(LB_MINIMAL));
    expect(structuredClone(result)).toEqual(result);
  });
});
