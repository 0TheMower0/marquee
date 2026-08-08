import { describe, expect, it } from "vitest";

import { parseCsvTable, type CsvRecord } from "../csv";

import { TRAKT_COMMUNITY_RATING_COLUMNS, readTraktUserRating } from "./trakt";

/**
 * ============================================================================
 * WRITTEN BEFORE THE PARSER IT PROTECTS
 * ============================================================================
 * Trakt's VIP export carries the user's own score and the COMMUNITY average
 * side by side:
 *
 *   rating                  the user's own score        <- the only one we want
 *   trakt_rating            the community average
 *   episode_trakt_rating    the community average, per episode
 *
 * Reading a community column as the user's score would replace someone's
 * entire rating history with crowd averages: every row plausible, every row
 * wrong, and nothing anywhere to notice it. It is the most destructive single
 * field in any format this project supports.
 *
 * These tests exist before `readTraktUserRating` does, deliberately. A test
 * written afterwards is shaped around code that already works; one written
 * first has to describe the hazard on its own terms.
 */

const VIP_RATINGS_HEADER =
  "rated_at,type,title,year,trakt_rating,trakt_id,imdb_id,tmdb_id,tvdb_id,url,released," +
  "season_number,episode_number,episode_title,episode_released,episode_trakt_rating," +
  "episode_trakt_id,episode_imdb_id,episode_tmdb_id,episode_tvdb_id,genres,rating";

/** Builds one VIP ratings record. `rating` is last, `trakt_rating` fifth —
 *  the real column order, so a positional mistake would show up here. */
function vipRow(options: {
  title: string;
  traktRating: string;
  episodeTraktRating?: string;
  userRating: string;
}): CsvRecord {
  const cells = [
    "2023-01-01T00:00:00.000Z", // rated_at
    "movie", // type
    options.title,
    "1972", // year
    options.traktRating, // trakt_rating  <- COMMUNITY
    "1", // trakt_id
    "tt0068646", // imdb_id
    "238", // tmdb_id
    "", // tvdb_id
    "https://trakt.tv/movies/x", // url
    "1972-03-24", // released
    "", // season_number
    "", // episode_number
    "", // episode_title
    "", // episode_released
    options.episodeTraktRating ?? "", // episode_trakt_rating <- COMMUNITY
    "", // episode_trakt_id
    "", // episode_imdb_id
    "", // episode_tmdb_id
    "", // episode_tvdb_id
    "Crime", // genres
    options.userRating, // rating <- THE USER'S OWN
  ];
  return parseCsvTable(`${VIP_RATINGS_HEADER}\n${cells.join(",")}`).rows[0];
}

describe("readTraktUserRating", () => {
  it("reads the user's own rating, not the community average", () => {
    // Both plausible, both different — so a swapped column cannot pass by
    // coincidence the way it could with 0/null placeholders.
    const record = vipRow({ title: "The Godfather", traktRating: "7", userRating: "9" });
    expect(readTraktUserRating(record)).toBe(90);
  });

  it("returns NULL when the user did not rate it, even though the community did", () => {
    /**
     * ========================================================================
     * THE ONE THAT WOULD ACTUALLY SHIP
     * ========================================================================
     * Reading the wrong column outright is the obvious bug and the test above
     * catches it. The subtle one is reading the RIGHT column and falling back
     * to the community average when it is empty — a `??` or `||` chain that
     * looks like defensive coding and is anything but.
     *
     * Its victims are precisely the titles the user deliberately chose not to
     * rate, which would silently acquire a crowd score. Nothing in the UI
     * would distinguish those from ratings they actually entered.
     */
    const record = vipRow({ title: "Jaws", traktRating: "8", userRating: "" });
    expect(readTraktUserRating(record)).toBeNull();
  });

  it("never falls back to the per-episode community average either", () => {
    // `episode_trakt_rating` is a second community column, easy to miss when
    // only `trakt_rating` is on your mind.
    const record = vipRow({
      title: "Ozymandias",
      traktRating: "",
      episodeTraktRating: "10",
      userRating: "",
    });
    expect(readTraktUserRating(record)).toBeNull();
  });

  it("never returns a value derived from ANY community column", () => {
    // A whole-fixture sweep rather than a per-column assertion, so a
    // community column added by Trakt later is covered without this test
    // being updated to know about it.
    const fixtures = [
      { traktRating: "7", userRating: "9" },
      { traktRating: "9", userRating: "" },
      { traktRating: "3", episodeTraktRating: "8", userRating: "" },
      { traktRating: "10", userRating: "1" },
    ];

    for (const fixture of fixtures) {
      const record = vipRow({ title: "X", ...fixture });
      const score = readTraktUserRating(record);
      if (score === null) continue;

      for (const column of TRAKT_COMMUNITY_RATING_COLUMNS) {
        const community = record.get(column);
        if (community === null) continue;
        expect(
          score,
          `readTraktUserRating returned a score matching the community column "${column}"`,
        ).not.toBe(Number(community) * 10);
      }
    }
  });

  it("normalizes Trakt's 1-10 scale onto our 0-100 grid", () => {
    expect(readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "10" }))).toBe(100);
    expect(readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "1" }))).toBe(10);
    // The same grid IMDb and Letterboxd land on, so a user importing from
    // several sources does not end up with three scales in one library.
    expect(readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "8" }))).toBe(80);
  });

  it("rejects out-of-range values rather than clamping them", () => {
    expect(readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "0" }))).toBeNull();
    expect(readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "11" }))).toBeNull();
    expect(
      readTraktUserRating(vipRow({ title: "a", traktRating: "", userRating: "banana" })),
    ).toBeNull();
  });

  it("returns null when the export has no user rating column at all", () => {
    // Community-tool exports carry no `rating` column. Absent must read as
    // "not rated", never as an invitation to look elsewhere.
    const record = parseCsvTable("imdb,trakt,watched_at,title\ntt1,1,2019-01-01T00:00:00Z,X")
      .rows[0];
    expect(readTraktUserRating(record)).toBeNull();
  });

  it("names every community column it refuses to read", () => {
    // The rejection is data, not a comment — so a reviewer can see what is
    // being excluded, and the sweep above can iterate it.
    expect(TRAKT_COMMUNITY_RATING_COLUMNS).toContain("trakt_rating");
    expect(TRAKT_COMMUNITY_RATING_COLUMNS).toContain("episode_trakt_rating");
  });
});
