import { describe, expect, it } from "vitest";

import { parseCsvTable } from "../csv";

import { detectSource, parseAs } from "./index";
import { hasNoResolvablePath, traktTmdbId, unresolvableIdColumns } from "./trakt";

/**
 * Headers are the ones verified in design doc §11, in their real column
 * order — including columns this parser ignores, because a parser tested only
 * against a trimmed fixture has not been tested.
 */

const VIP_HISTORY =
  "watched_at,type,title,year,trakt_rating,trakt_id,imdb_id,tmdb_id,tvdb_id,url,released," +
  "season_number,episode_number,episode_title,genres,rating";

const VIP_RATINGS =
  "rated_at,type,title,year,trakt_rating,trakt_id,imdb_id,tmdb_id,tvdb_id,url,released," +
  "season_number,episode_number,episode_title,genres,rating";

const VIP_COLLECTION =
  "collected_at,type,title,year,trakt_rating,trakt_id,imdb_id,tmdb_id,url,released,runtime,genres";

/** Community tool: the id column's NAME is its type, and there is no year. */
const COMMUNITY_IMDB = "imdb,trakt,watched_at,title";
const COMMUNITY_TMDB = "tmdb,trakt,watched_at,title";
const COMMUNITY_EPISODES = "tmdb,trakt,watched_at,season,episode,episode_title,show_title";
const COMMUNITY_TRAKT_ONLY = "trakt,watched_at,title";

describe("detection", () => {
  it("identifies each VIP export from its timestamp column", () => {
    expect(detectSource(parseCsvTable(`${VIP_HISTORY}\n`))).toBe("trakt-history");
    expect(detectSource(parseCsvTable(`${VIP_RATINGS}\n`))).toBe("trakt-ratings");
    expect(detectSource(parseCsvTable(`${VIP_COLLECTION}\n`))).toBe("trakt-watchlist");
  });

  it("identifies community-tool exports too", () => {
    expect(detectSource(parseCsvTable(`${COMMUNITY_IMDB}\n`))).toBe("trakt-history");
    expect(detectSource(parseCsvTable(`${COMMUNITY_EPISODES}\n`))).toBe("trakt-history");
  });

  it("does not mistake a Letterboxd or IMDb export for Trakt", () => {
    expect(detectSource(parseCsvTable("Date,Name,Year,Letterboxd URI,Rating\n"))).toBe(
      "letterboxd-ratings",
    );
    expect(
      detectSource(
        parseCsvTable("Const,Your Rating,Date Rated,Title,URL,Title Type,Year\n"),
      ),
    ).toBe("imdb-ratings");
  });
});

describe("VIP export parsing", () => {
  const rows = parseAs(
    parseCsvTable(
      `${VIP_HISTORY}\n` +
        `2019-03-14T20:15:00.000Z,movie,The Godfather,1972,8.9,1,tt0068646,238,,url,1972-03-24,,,,Crime,9\n` +
        `2019-06-02T09:05:00.000Z,episode,Breaking Bad,2008,9.4,2,tt0903747,1396,,url,2008-01-20,5,14,Ozymandias,Drama,10`,
    ),
    "trakt-history",
  );

  it("reads the user's rating, never the community one", () => {
    // 8.9 and 9.4 are the community averages sitting right beside them.
    expect(rows[0].score).toBe(90);
    expect(rows[1].score).toBe(100);
  });

  it("converts the instant to a local day AND a real minute", () => {
    // No other supported source can supply a watch TIME.
    expect(rows[0].watchedOn).toBe("2019-03-14");
    expect(rows[0].watchedMinute).not.toBeNull();
  });

  it("carries episode coordinates", () => {
    expect(rows[1].season).toBe(5);
    expect(rows[1].episode).toBe(14);
    expect(rows[1].mediaTypeHint).toBe("episode");
  });

  it("uses the SHOW's identity for an episode row, not the episode's", () => {
    // Required by lib/import/review-units.ts: an episode row must dedup on
    // its show, or 62 episodes become 62 review decisions.
    expect(rows[1].title).toBe("Breaking Bad");
    expect(rows[1].imdbId).toBe("tt0903747");
    expect(rows[1].year).toBe(2008);
  });

  it("marks history rows watched", () => {
    expect(rows.every((row) => row.intent === "watched")).toBe(true);
  });

  it("treats a collection export as watchlist, not watched", () => {
    // `collected_at` means the user OWNS it. Mapping that to watched would
    // invent a viewing history out of a shelf.
    const collected = parseAs(
      parseCsvTable(
        `${VIP_COLLECTION}\n2020-01-01T00:00:00Z,movie,Jaws,1975,8.1,3,tt0073195,578,url,1975-06-20,124,Thriller`,
      ),
      "trakt-watchlist",
    );
    expect(collected[0].intent).toBe("watchlist");
    expect(collected[0].watchedOn).toBeNull();
  });

  it("records a rating date without claiming a watch date", () => {
    const rated = parseAs(
      parseCsvTable(
        `${VIP_RATINGS}\n2021-05-04T12:00:00Z,movie,Alien,1979,8.4,4,tt0078748,348,,url,1979-05-25,,,,Horror,9`,
      ),
      "trakt-ratings",
    );
    expect(rated[0].ratedOn).toBe("2021-05-04");
    expect(rated[0].watchedOn).toBeNull();
    expect(rated[0].intent).toBe("rating-only");
  });
});

describe("community-tool export parsing", () => {
  it("reads an imdb id column", () => {
    const rows = parseAs(
      parseCsvTable(`${COMMUNITY_IMDB}\ntt0068646,1,2019-03-14T20:15:00Z,The Godfather`),
      "trakt-history",
    );
    expect(rows[0].imdbId).toBe("tt0068646");
    expect(rows[0].watchedOn).toBe("2019-03-14");
  });

  it("has no year, so such rows can never auto-match by title", () => {
    // Design doc §2.3: a missing year is never an exact year agreement.
    const rows = parseAs(
      parseCsvTable(`${COMMUNITY_IMDB}\ntt0068646,1,2019-03-14T20:15:00Z,The Godfather`),
      "trakt-history",
    );
    expect(rows[0].year).toBeNull();
  });

  it("uses show_title for episode rows", () => {
    const rows = parseAs(
      parseCsvTable(
        `${COMMUNITY_EPISODES}\n1396,2,2019-06-02T09:05:00Z,5,14,Ozymandias,Breaking Bad`,
      ),
      "trakt-history",
    );
    expect(rows[0].title).toBe("Breaking Bad");
    expect(rows[0].season).toBe(5);
    expect(rows[0].episode).toBe(14);
  });

  it("carries no rating, because the format has no rating column", () => {
    const rows = parseAs(
      parseCsvTable(`${COMMUNITY_IMDB}\ntt0068646,1,2019-03-14T20:15:00Z,X`),
      "trakt-history",
    );
    expect(rows[0].score).toBeNull();
  });
});

describe("telling the user up front when nothing can be resolved", () => {
  it("flags a trakt-id-only export as unresolvable", () => {
    // No id we can use AND no year — every row would land in review. Saying
    // so before a multi-minute resolve is the whole point.
    const table = parseCsvTable(`${COMMUNITY_TRAKT_ONLY}\n1,2019-03-14T20:15:00Z,X`);
    expect(unresolvableIdColumns(table)).toContain("trakt");
    expect(hasNoResolvablePath(table)).toBe(true);
  });

  it("does NOT flag an export that has a usable id", () => {
    expect(unresolvableIdColumns(parseCsvTable(`${COMMUNITY_IMDB}\n`))).toEqual([]);
    expect(unresolvableIdColumns(parseCsvTable(`${COMMUNITY_TMDB}\n`))).toEqual([]);
    expect(hasNoResolvablePath(parseCsvTable(`${COMMUNITY_IMDB}\n`))).toBe(false);
  });

  it("does NOT flag the VIP export, which carries both an id and a year", () => {
    const table = parseCsvTable(`${VIP_HISTORY}\n`);
    expect(unresolvableIdColumns(table)).toEqual([]);
    expect(hasNoResolvablePath(table)).toBe(false);
  });

  it("treats a trakt-id export WITH a year as resolvable by title", () => {
    // Unusable id, but a year means title+year matching can still reach
    // `confident`. Not the same situation, and must not warn as if it were.
    const table = parseCsvTable("trakt,watched_at,title,year\n1,2019-01-01T00:00:00Z,X,1999");
    expect(hasNoResolvablePath(table)).toBe(false);
  });
});

describe("traktTmdbId", () => {
  it("reads a TMDB id straight from the row — no lookup needed at all", () => {
    const table = parseCsvTable(
      `${VIP_HISTORY}\n2019-03-14T20:15:00Z,movie,The Godfather,1972,8.9,1,tt0068646,238,,url,1972-03-24,,,,Crime,9`,
    );
    expect(traktTmdbId(table.rows[0])).toBe("238");
  });

  it("reads the community column name too", () => {
    const table = parseCsvTable(`${COMMUNITY_TMDB}\n1396,2,2019-01-01T00:00:00Z,X`);
    expect(traktTmdbId(table.rows[0])).toBe("1396");
  });

  it("rejects a non-numeric id rather than sending junk upstream", () => {
    const table = parseCsvTable(`${COMMUNITY_TMDB}\nnot-a-number,2,2019-01-01T00:00:00Z,X`);
    expect(traktTmdbId(table.rows[0])).toBeNull();
  });
});
