import { describe, expect, it } from "vitest";

import type { MediaType, TitleSummary } from "@/lib/content/types";

import {
  buildReviewUnits,
  isUnitPending,
  sortUnitsEasiestFirst,
} from "./review-units";
import type { ImportRow, MatchCandidate, ResolvedRow } from "./types";

function summary(id: string, name: string, mediaType: MediaType = "tv"): TitleSummary {
  return {
    id,
    mediaType,
    name,
    year: 2008,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
  };
}

function candidate(score: number): MatchCandidate {
  return { summary: summary("x", "X"), score, reason: "because" };
}

let line = 1;
function row(overrides: Partial<ImportRow> = {}): ImportRow {
  line += 1;
  return {
    source: "letterboxd-diary",
    sourceRowId: `r:${line}`,
    imdbId: null,
    tmdbId: null,
    title: "Breaking Bad",
    originalTitle: null,
    year: 2008,
    slug: null,
    mediaTypeHint: "tv",
    score: null,
    ratedOn: null,
    watchedOn: null,
    season: null,
    episode: null,
    watchedMinute: null,
    isRewatch: false,
    intent: "watched",
    sourceLine: line,
    ...overrides,
  };
}

function ambiguous(r: ImportRow, candidates: MatchCandidate[] = [candidate(50)]): ResolvedRow {
  return { row: r, bucket: "ambiguous", candidates, chosen: null, skipped: false };
}

describe("buildReviewUnits — a unit is a dedup group", () => {
  it("collapses a show's episodes into ONE decision", () => {
    // The headline: 62 rows, one question — which show is this?
    const rows = Array.from({ length: 62 }, (_, i) =>
      ambiguous(row({ season: 1 + Math.floor(i / 13), episode: (i % 13) + 1 })),
    );

    const units = buildReviewUnits(rows);
    expect(units).toHaveLength(1);
    expect(units[0].rowCount).toBe(62);
    expect(units[0].episodeCount).toBe(62);
    expect(units[0].indices).toHaveLength(62);
  });

  it("collapses a rewatched film into one decision too — no episode special case", () => {
    const rows = [
      ambiguous(row({ title: "Heat", year: 1995, watchedOn: "2020-01-01" })),
      ambiguous(row({ title: "Heat", year: 1995, watchedOn: "2021-06-01" })),
    ];
    const units = buildReviewUnits(rows);
    expect(units).toHaveLength(1);
    expect(units[0].rowCount).toBe(2);
    expect(units[0].episodeCount).toBe(0);
  });

  it("makes a lone title row a unit of one", () => {
    const units = buildReviewUnits([ambiguous(row({ title: "Solaris", year: 1972 }))]);
    expect(units).toHaveLength(1);
    expect(units[0].rowCount).toBe(1);
  });

  it("keeps genuinely different titles as separate units", () => {
    const units = buildReviewUnits([
      ambiguous(row({ title: "Heat", year: 1995 })),
      ambiguous(row({ title: "Alien", year: 1979 })),
    ]);
    expect(units).toHaveLength(2);
  });

  it("does not group two shows that merely share a season number", () => {
    const units = buildReviewUnits([
      ambiguous(row({ title: "Breaking Bad", year: 2008, season: 1, episode: 1 })),
      ambiguous(row({ title: "The Wire", year: 2002, season: 1, episode: 1 })),
    ]);
    expect(units).toHaveLength(2);
  });

  it("groups by the SHOW's identity, which is what the parser must supply", () => {
    // An episode row whose title/year describe the show groups; one carrying
    // the episode's own name would not, and would produce N decisions.
    const grouped = buildReviewUnits([
      ambiguous(row({ title: "Breaking Bad", season: 1, episode: 1 })),
      ambiguous(row({ title: "Breaking Bad", season: 5, episode: 14 })),
    ]);
    expect(grouped).toHaveLength(1);

    const ungrouped = buildReviewUnits([
      ambiguous(row({ title: "Pilot", season: 1, episode: 1 })),
      ambiguous(row({ title: "Ozymandias", season: 5, episode: 14 })),
    ]);
    expect(ungrouped).toHaveLength(2);
  });

  it("excludes rows that need no review", () => {
    const rows: ResolvedRow[] = [
      ambiguous(row({ title: "Heat", year: 1995 })),
      { ...ambiguous(row({ title: "Alien", year: 1979 })), bucket: "confident", chosen: summary("a", "Alien") },
      { ...ambiguous(row({ title: "Jaws", year: 1975 })), skipped: true },
    ];
    const units = buildReviewUnits(rows);
    expect(units).toHaveLength(1);
    expect(units[0].representative.row.title).toBe("Heat");
  });

  it("indices point back at the ORIGINAL array", () => {
    const rows = [
      { ...ambiguous(row({ title: "Alien", year: 1979 })), bucket: "confident" as const, chosen: summary("a", "Alien") },
      ambiguous(row({ title: "Heat", year: 1995 })),
      ambiguous(row({ title: "Heat", year: 1995 })),
    ];
    const units = buildReviewUnits(rows);
    expect(units[0].indices).toEqual([1, 2]);
  });
});

describe("unit summaries", () => {
  it("reports season spread and date range across the group", () => {
    const rows = [
      ambiguous(row({ season: 1, episode: 1, watchedOn: "2019-03-14" })),
      ambiguous(row({ season: 1, episode: 2, watchedOn: "2019-01-02" })),
      ambiguous(row({ season: 3, episode: 7, watchedOn: "2019-06-02" })),
    ];
    const [unit] = buildReviewUnits(rows);

    expect(unit.episodeCount).toBe(3);
    expect(unit.seasonCount).toBe(2);
    expect(unit.earliestDate).toBe("2019-01-02");
    expect(unit.latestDate).toBe("2019-06-02");
  });

  it("reports the line range so the user can find the rows in their file", () => {
    const a = ambiguous(row({ title: "Heat", year: 1995 }));
    const b = ambiguous(row({ title: "Heat", year: 1995 }));
    const [unit] = buildReviewUnits([a, b]);

    expect(unit.firstLine).toBe(Math.min(a.row.sourceLine, b.row.sourceLine));
    expect(unit.lastLine).toBe(Math.max(a.row.sourceLine, b.row.sourceLine));
  });

  it("has null dates when no row carries one", () => {
    const [unit] = buildReviewUnits([ambiguous(row({ title: "Heat", year: 1995 }))]);
    expect(unit.earliestDate).toBeNull();
    expect(unit.latestDate).toBeNull();
  });
});

describe("sortUnitsEasiestFirst", () => {
  it("leads with the strongest top candidate", () => {
    const units = buildReviewUnits([
      ambiguous(row({ title: "Weak", year: 2000 }), [candidate(20)]),
      ambiguous(row({ title: "Strong", year: 2000 }), [candidate(90)]),
      ambiguous(row({ title: "None", year: 2000 }), []),
    ]);

    expect(sortUnitsEasiestFirst(units).map((u) => u.representative.row.title)).toEqual([
      "Strong",
      "Weak",
      "None",
    ]);
  });

  it("keeps file order for ties, so the sort is deterministic", () => {
    const units = buildReviewUnits([
      ambiguous(row({ title: "First", year: 2000 }), [candidate(50)]),
      ambiguous(row({ title: "Second", year: 2000 }), [candidate(50)]),
    ]);
    expect(sortUnitsEasiestFirst(units).map((u) => u.representative.row.title)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("does not mutate its input", () => {
    const units = buildReviewUnits([
      ambiguous(row({ title: "A", year: 2000 }), [candidate(10)]),
      ambiguous(row({ title: "B", year: 2000 }), [candidate(99)]),
    ]);
    const before = units.map((u) => u.key);
    sortUnitsEasiestFirst(units);
    expect(units.map((u) => u.key)).toEqual(before);
  });
});

describe("isUnitPending", () => {
  it("is resolved the moment its representative is — one decision covers all", () => {
    const rows = [
      ambiguous(row({ title: "Heat", year: 1995 })),
      ambiguous(row({ title: "Heat", year: 1995 })),
    ];
    const [unit] = buildReviewUnits(rows);
    expect(isUnitPending(unit, rows)).toBe(true);

    const decided = rows.map((r) => ({ ...r, chosen: summary("a", "Heat", "movie") }));
    expect(isUnitPending(unit, decided)).toBe(false);
  });

  it("is resolved by a skip too", () => {
    const rows = [ambiguous(row({ title: "Heat", year: 1995 }))];
    const [unit] = buildReviewUnits(rows);
    expect(isUnitPending(unit, [{ ...rows[0], skipped: true }])).toBe(false);
  });
});
