import { describe, expect, it } from "vitest";

import { parseCsvTable } from "../csv";
import { normalizeImdbRating, normalizeLetterboxdRating, parseYear } from "../types";

import { detectSource, parseAs, parseTable } from "./index";
import { isAmbiguousLetterboxdTable, letterboxdSlug } from "./letterboxd";

/**
 * Fixtures use the REAL verified headers (design doc §0), in the real column
 * order, including the columns we ignore — a parser that only works against a
 * trimmed-down fixture is a parser that has not been tested.
 */

const IMDB_RATINGS_HEADER =
  "Const,Your Rating,Date Rated,Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors";

const IMDB_WATCHLIST_HEADER =
  "Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated";

const LB_DIARY_HEADER = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date";
const LB_RATINGS_HEADER = "Date,Name,Year,Letterboxd URI,Rating";
const LB_MINIMAL_HEADER = "Date,Name,Year,Letterboxd URI";

describe("source detection", () => {
  it("identifies an IMDb ratings export", () => {
    const table = parseCsvTable(`${IMDB_RATINGS_HEADER}\ntt0068646,10,2020-01-01,The Godfather,url,movie,9.2,175,1972,Crime,2000000,1972-03-24,Coppola`);
    expect(detectSource(table)).toBe("imdb-ratings");
  });

  it("identifies an IMDb watchlist export, NOT as a ratings export", () => {
    // A watchlist export also has `Your Rating` and `Date Rated`, so an
    // ordering mistake here would silently misread every watchlist as ratings
    // — importing "plan to watch" as "watched".
    const table = parseCsvTable(`${IMDB_WATCHLIST_HEADER}\n1,tt0068646,2020-01-01,2020-01-01,,The Godfather,,url,movie,9.2,175,1972,Crime,2000000,1972-03-24,Coppola,,`);
    expect(detectSource(table)).toBe("imdb-watchlist");
  });

  it("identifies a Letterboxd diary by its Watched Date column", () => {
    const table = parseCsvTable(`${LB_DIARY_HEADER}\n2019-03-20,Gravity,2013,uri,4,Yes,,2019-03-14`);
    expect(detectSource(table)).toBe("letterboxd-diary");
  });

  it("identifies a Letterboxd ratings export", () => {
    const table = parseCsvTable(`${LB_RATINGS_HEADER}\n2019-03-20,Gravity,2013,uri,4`);
    expect(detectSource(table)).toBe("letterboxd-ratings");
  });

  it("returns null for a file that is not a supported export", () => {
    expect(detectSource(parseCsvTable("foo,bar\n1,2"))).toBeNull();
  });

  describe("watchlist.csv vs watched.csv — identical headers", () => {
    const table = parseCsvTable(`${LB_MINIMAL_HEADER}\n2019-03-20,Gravity,2013,uri`);

    it("cannot be resolved from the header alone", () => {
      expect(isAmbiguousLetterboxdTable(table)).toBe(true);
      expect(detectSource(table)).toBeNull();
    });

    it("is resolved by filename when one is available", () => {
      expect(detectSource(table, "watchlist.csv")).toBe("letterboxd-watchlist");
      expect(detectSource(table, "watched.csv")).toBe("letterboxd-watched");
    });

    it("stays null for an unhelpful filename rather than guessing", () => {
      // Guessing here would mean a coin flip between "plan to watch" and
      // "have seen" across the user's entire library.
      expect(detectSource(table, "export (1).csv")).toBeNull();
    });

    it("is not ambiguous for files the header DOES resolve", () => {
      expect(isAmbiguousLetterboxdTable(parseCsvTable(LB_DIARY_HEADER))).toBe(false);
      expect(isAmbiguousLetterboxdTable(parseCsvTable(LB_RATINGS_HEADER))).toBe(false);
    });
  });
});

describe("IMDb parsing", () => {
  const table = parseCsvTable(
    `${IMDB_RATINGS_HEADER}\n` +
      `tt0068646,10,2020-05-04,The Godfather,url,movie,9.2,175,1972,Crime,2000000,1972-03-24,Coppola\n` +
      `tt0903747,9,2021-01-02,Breaking Bad,url,tvSeries,9.5,49,2008,Drama,1800000,2008-01-20,Gilligan\n` +
      `tt2301451,8,2021-02-02,Ozymandias,url,tvEpisode,10.0,48,2013,Drama,150000,2013-09-15,Johnson`,
  );
  const rows = parseAs(table, "imdb-ratings");

  it("extracts the IMDb id, which is what makes these Tier 1 matches", () => {
    expect(rows[0].imdbId).toBe("tt0068646");
  });

  it("normalizes the 1-10 rating onto our 0-100 scale", () => {
    expect(rows[0].score).toBe(100);
    expect(rows[1].score).toBe(90);
  });

  it("maps Title Type onto a media-type hint", () => {
    expect(rows[0].mediaTypeHint).toBe("movie");
    expect(rows[1].mediaTypeHint).toBe("tv");
    expect(rows[2].mediaTypeHint).toBe("episode");
  });

  it("records the rating date but NOT a watch date", () => {
    // IMDb has no watch dates. Synthesizing one from `Date Rated` is an
    // explicit opt-in handled at commit time — never silently here.
    expect(rows[0].ratedOn).toBe("2020-05-04");
    expect(rows[0].watchedOn).toBeNull();
  });

  it("marks ratings as rating-only, and watchlists as watchlist", () => {
    expect(rows[0].intent).toBe("rating-only");

    const watchlist = parseAs(
      parseCsvTable(`${IMDB_WATCHLIST_HEADER}\n1,tt0111161,2019-01-01,2019-01-01,,The Shawshank Redemption,,url,movie,9.3,142,1994,Drama,2700000,1994-09-23,Darabont,,`),
      "imdb-watchlist",
    );
    expect(watchlist[0].intent).toBe("watchlist");
    expect(watchlist[0].watchedOn).toBeNull();
  });

  it("gives every row a unique, re-parse-stable id", () => {
    expect(new Set(rows.map((r) => r.sourceRowId)).size).toBe(rows.length);
    expect(parseAs(table, "imdb-ratings")[0].sourceRowId).toBe(rows[0].sourceRowId);
  });

  it("rejects a malformed Const rather than sending it to TMDB as an id", () => {
    const bad = parseAs(
      parseCsvTable(`${IMDB_RATINGS_HEADER}\nnot-an-id,8,2020-01-01,X,url,movie,7,90,2001,Drama,10,2001-01-01,Someone`),
      "imdb-ratings",
    );
    expect(bad[0].imdbId).toBeNull();
  });

  it("drops rows with no title at all", () => {
    const empty = parseAs(
      parseCsvTable(`${IMDB_RATINGS_HEADER}\ntt0000001,8,2020-01-01,,url,movie,7,90,2001,Drama,10,2001-01-01,X`),
      "imdb-ratings",
    );
    expect(empty).toEqual([]);
  });
});

describe("Letterboxd parsing", () => {
  const diary = parseAs(
    parseCsvTable(
      `${LB_DIARY_HEADER}\n` +
        `2019-03-20,Gravity,2013,https://letterboxd.com/me/film/gravity-2013/1/,4,Yes,,2019-03-14\n` +
        `2019-04-02,"Dinner, Then Bed",2019,https://letterboxd.com/me/film/dinner-then-bed/,3.5,,,2019-04-01`,
    ),
    "letterboxd-diary",
  );

  it("never produces an IMDb id — the defining constraint of this source", () => {
    expect(diary.every((row) => row.imdbId === null)).toBe(true);
  });

  it("uses Watched Date, not the logged Date", () => {
    expect(diary[0].watchedOn).toBe("2019-03-14");
    expect(diary[1].watchedOn).toBe("2019-04-01");
  });

  it("normalizes half-star ratings onto the same grid as IMDb", () => {
    // 4 stars and 8/10 must both be 80, or a user importing from both ends up
    // with two scales in one library.
    expect(diary[0].score).toBe(80);
    expect(diary[1].score).toBe(70);
    expect(normalizeLetterboxdRating("4")).toBe(normalizeImdbRating("8"));
  });

  it("carries the rewatch flag", () => {
    expect(diary[0].isRewatch).toBe(true);
    expect(diary[1].isRewatch).toBe(false);
  });

  it("keeps a title containing a comma intact", () => {
    expect(diary[1].title).toBe("Dinner, Then Bed");
  });

  it("keeps EVERY diary row for a rewatched film, as separate events", () => {
    const rewatched = parseAs(
      parseCsvTable(
        `${LB_DIARY_HEADER}\n` +
          `2020-01-02,Heat,1995,uri,5,,,2020-01-01\n` +
          `2021-06-02,Heat,1995,uri,5,Yes,,2021-06-01\n` +
          `2021-06-03,Heat,1995,uri,5,Yes,,2021-06-01`,
      ),
      "letterboxd-diary",
    );
    // Three viewings, including two on the SAME date — all distinct.
    expect(rewatched).toHaveLength(3);
    expect(new Set(rewatched.map((r) => r.sourceRowId)).size).toBe(3);
  });

  it("does not treat watched.csv's logged Date as a watch date", () => {
    // A user who logged 400 films in one evening in 2016 must not import a
    // 400-film day that never happened.
    const watched = parseAs(
      parseCsvTable(`${LB_MINIMAL_HEADER}\n2016-08-01,Gravity,2013,uri`),
      "letterboxd-watched",
    );
    expect(watched[0].watchedOn).toBeNull();
    expect(watched[0].intent).toBe("watched");
  });

  it("hints movie for every row — Letterboxd is films only", () => {
    expect(diary.every((row) => row.mediaTypeHint === "movie")).toBe(true);
  });
});

describe("letterboxdSlug", () => {
  it("reads the slug from a film-page URI (ratings/watched/watchlist)", () => {
    expect(letterboxdSlug("https://letterboxd.com/film/the-godfather/")).toBe("the-godfather");
  });

  it("reads it from a user-specific diary URI too", () => {
    // Letterboxd's own export is inconsistent between files; both shapes have
    // to work or diary rows lose their best matching signal.
    expect(letterboxdSlug("https://letterboxd.com/someone/film/gravity-2013/2/")).toBe(
      "gravity-2013",
    );
  });

  it("returns null for a boxd.it short link, which carries no slug", () => {
    expect(letterboxdSlug("https://boxd.it/1a2b3c")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(letterboxdSlug(null)).toBeNull();
  });
});

describe("rating and year normalization", () => {
  it("rejects out-of-range ratings rather than clamping them", () => {
    expect(normalizeImdbRating("0")).toBeNull();
    expect(normalizeImdbRating("11")).toBeNull();
    expect(normalizeLetterboxdRating("0")).toBeNull();
    expect(normalizeLetterboxdRating("5.5")).toBeNull();
  });

  it("treats a blank rating as absent", () => {
    expect(normalizeImdbRating(null)).toBeNull();
    expect(normalizeLetterboxdRating("")).toBeNull();
  });

  it("covers the whole Letterboxd half-star range", () => {
    expect(normalizeLetterboxdRating("0.5")).toBe(10);
    expect(normalizeLetterboxdRating("5")).toBe(100);
  });

  it("rejects implausible years so a stray column never becomes a signal", () => {
    expect(parseYear("1972")).toBe(1972);
    expect(parseYear("0012")).toBeNull();
    expect(parseYear("banana")).toBeNull();
  });
});

describe("parseTable", () => {
  it("detects and parses in one step", () => {
    const result = parseTable(
      parseCsvTable(`${LB_DIARY_HEADER}\n2019-03-20,Gravity,2013,uri,4,,,2019-03-14`),
    );
    expect(result?.source).toBe("letterboxd-diary");
    expect(result?.rows).toHaveLength(1);
  });

  it("returns null for an unrecognized file, so the caller can say WHY", () => {
    // Distinct from "parsed fine, zero rows" — different message to the user.
    expect(parseTable(parseCsvTable("a,b\n1,2"))).toBeNull();
  });
});
