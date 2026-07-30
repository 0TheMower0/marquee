import { describe, expect, it } from "vitest";

import { toExternalRatings, type OmdbResponse } from "./normalize";

/**
 * These fixtures are shaped after REAL OMDb responses, not invented ones.
 *
 * That is the point of this file. Mock-mode data is clean by construction, so
 * it cannot catch the class of bug that only appears against a live upstream —
 * "N/A" strings where a number is expected, comma-grouped vote counts, a
 * failure reported as HTTP 200, a source silently missing from `Ratings[]`.
 * Every case below is one of those.
 */

const FULL: OmdbResponse = {
  Response: "True",
  Ratings: [
    { Source: "Internet Movie Database", Value: "7.8/10" },
    { Source: "Rotten Tomatoes", Value: "85%" },
    { Source: "Metacritic", Value: "72/100" },
  ],
  imdbRating: "7.8",
  imdbVotes: "812,345",
  Metascore: "72",
};

describe("toExternalRatings — the happy path", () => {
  it("extracts all three sources in their native scales", () => {
    expect(toExternalRatings(FULL)).toEqual([
      { source: "imdb", value: 7.8, scale: "ten", votes: 812345 },
      { source: "rotten_tomatoes", value: 85, scale: "percent", votes: null },
      { source: "metacritic", value: 72, scale: "hundred", votes: null },
    ]);
  });

  it("strips comma grouping from vote counts", () => {
    const [imdb] = toExternalRatings({ ...FULL, imdbVotes: "1,234,567" });
    expect(imdb.votes).toBe(1234567);
  });

  it("returns sources in a stable order regardless of OMDb's array order", () => {
    const shuffled: OmdbResponse = {
      ...FULL,
      Ratings: [
        { Source: "Metacritic", Value: "72/100" },
        { Source: "Rotten Tomatoes", Value: "85%" },
        { Source: "Internet Movie Database", Value: "7.8/10" },
      ],
    };
    expect(toExternalRatings(shuffled).map((r) => r.source)).toEqual([
      "imdb",
      "rotten_tomatoes",
      "metacritic",
    ]);
  });
});

describe('toExternalRatings — OMDb\'s "N/A" convention', () => {
  // OMDb never omits a field it knows about; it sends the literal string
  // "N/A". Parsing that as a number yields NaN, which would render as
  // "NaN/10" on the page.
  it("drops a source whose value is N/A rather than emitting NaN", () => {
    const result = toExternalRatings({
      Response: "True",
      imdbRating: "N/A",
      imdbVotes: "N/A",
      Metascore: "N/A",
      Ratings: [],
    });
    expect(result).toEqual([]);
  });

  it("keeps the sources that ARE present when others are N/A", () => {
    const result = toExternalRatings({
      Response: "True",
      imdbRating: "6.1",
      imdbVotes: "N/A",
      Metascore: "N/A",
      Ratings: [{ Source: "Rotten Tomatoes", Value: "44%" }],
    });
    expect(result).toEqual([
      { source: "imdb", value: 6.1, scale: "ten", votes: null },
      { source: "rotten_tomatoes", value: 44, scale: "percent", votes: null },
    ]);
  });

  it("treats lowercase and padded n/a as absent too", () => {
    expect(toExternalRatings({ Response: "True", imdbRating: " n/a " })).toEqual([]);
  });
});

describe("toExternalRatings — partial coverage", () => {
  // Very common in reality: plenty of titles have an IMDb score but no
  // Rotten Tomatoes or Metacritic entry at all.
  it("handles IMDb only", () => {
    expect(
      toExternalRatings({
        Response: "True",
        imdbRating: "8.2",
        imdbVotes: "45,120",
        Ratings: [{ Source: "Internet Movie Database", Value: "8.2/10" }],
      }),
    ).toEqual([{ source: "imdb", value: 8.2, scale: "ten", votes: 45120 }]);
  });

  it("reads a source from Ratings[] when the top-level field is missing", () => {
    // Metascore absent, but Metacritic present in the array.
    const result = toExternalRatings({
      Response: "True",
      Ratings: [{ Source: "Metacritic", Value: "91/100" }],
    });
    expect(result).toEqual([
      { source: "metacritic", value: 91, scale: "hundred", votes: null },
    ]);
  });

  it("handles a completely empty payload without throwing", () => {
    expect(toExternalRatings({})).toEqual([]);
    expect(toExternalRatings({ Response: "True" })).toEqual([]);
    expect(toExternalRatings({ Response: "True", Ratings: [] })).toEqual([]);
  });
});

describe("toExternalRatings — failure reported as success", () => {
  // The gotcha that makes status-code-only handling wrong: OMDb answers
  // "not found" with HTTP 200 and Response:"False".
  it('returns [] for Response:"False" even with a populated body', () => {
    expect(
      toExternalRatings({
        Response: "False",
        Error: "Incorrect IMDb ID.",
        imdbRating: "9.9",
      }),
    ).toEqual([]);
  });
});

describe("toExternalRatings — malformed and out-of-range values", () => {
  it("drops a non-numeric value instead of emitting NaN", () => {
    expect(
      toExternalRatings({
        Response: "True",
        imdbRating: "not a number",
        Ratings: [{ Source: "Rotten Tomatoes", Value: "fresh!" }],
      }),
    ).toEqual([]);
  });

  it("rejects values outside the source's own scale", () => {
    // A bar rendered from 250% would overflow its track.
    expect(
      toExternalRatings({
        Response: "True",
        imdbRating: "42",
        Ratings: [{ Source: "Rotten Tomatoes", Value: "250%" }],
      }),
    ).toEqual([]);
  });

  it("accepts the boundary values", () => {
    const result = toExternalRatings({
      Response: "True",
      imdbRating: "10.0",
      Ratings: [{ Source: "Rotten Tomatoes", Value: "0%" }],
      Metascore: "100",
    });
    expect(result.map((r) => r.value)).toEqual([10, 0, 100]);
  });

  it("ignores a zero or negative vote count", () => {
    const [imdb] = toExternalRatings({ ...FULL, imdbVotes: "0" });
    expect(imdb.votes).toBeNull();
  });

  it("matches source labels case-insensitively and ignores padding", () => {
    const result = toExternalRatings({
      Response: "True",
      Ratings: [{ Source: "  ROTTEN TOMATOES  ", Value: "77%" }],
    });
    expect(result).toEqual([
      { source: "rotten_tomatoes", value: 77, scale: "percent", votes: null },
    ]);
  });

  it("never returns a tmdb entry — that score is composed by the UI", () => {
    expect(toExternalRatings(FULL).some((r) => r.source === "tmdb")).toBe(false);
  });
});
