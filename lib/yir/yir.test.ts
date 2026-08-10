import { describe, expect, it } from "vitest";

import type { RatingEntry } from "@/lib/ratings/types";
import type { TrackingEntry } from "@/lib/tracking";
import { WATCH_KIND, type DayKey, type WatchEvent, type WatchLogDay } from "@/lib/watchlog";

import { headlineFor, isThinYear, selectCards, showsHours } from "./cards";
import { computeYir, rollingRange, type YirInput } from "./compute";

const TODAY: DayKey = "2026-08-11";

function tv(id: string, name: string, year: number, genres: string[], rating: number | null = null): TrackingEntry {
  return {
    id,
    mediaType: "tv",
    status: "watching",
    addedAt: new Date(TODAY),
    updatedAt: new Date(TODAY),
    watchedEpisodes: {},
    knownEpisodeCount: null,
    summary: {
      id,
      mediaType: "tv",
      name,
      year,
      overview: "",
      genres: genres.map((g) => ({ id: g.toLowerCase(), name: g })),
      posterUrl: null,
      placeholder: { gradientFrom: "#111", gradientTo: "#222" },
      rating,
    },
  };
}

function movie(
  id: string,
  name: string,
  year: number,
  genres: string[],
  rating: number | null = null,
  runtimeMinutes: number | null = 120,
): TrackingEntry {
  return {
    id,
    mediaType: "movie",
    status: "watched",
    addedAt: new Date(TODAY),
    updatedAt: new Date(TODAY),
    runtimeMinutes,
    summary: {
      id,
      mediaType: "movie",
      name,
      year,
      overview: "",
      genres: genres.map((g) => ({ id: g.toLowerCase(), name: g })),
      posterUrl: null,
      placeholder: { gradientFrom: "#111", gradientTo: "#222" },
      rating,
    },
  };
}

function rated(id: string, mediaType: "movie" | "tv", score: number, note = ""): RatingEntry {
  return { id, mediaType, score, note, updatedAt: new Date(TODAY) };
}

function ev(overrides: Partial<WatchEvent> & Pick<WatchEvent, "k" | "t">): WatchEvent {
  return { ...overrides } as WatchEvent;
}

function input(
  days: Record<DayKey, WatchLogDay>,
  entries: TrackingEntry[] = [],
  ratings: RatingEntry[] = [],
): YirInput {
  return { days: new Map(Object.entries(days)), entries, ratings, today: TODAY };
}

describe("rollingRange — 12 months, not a calendar year", () => {
  it("spans today back 364 days inclusive", () => {
    const range = rollingRange("2026-08-11");
    expect(range.to).toBe("2026-08-11");
    expect(range.from).toBe("2025-08-12");
  });

  it("does not snap to January", () => {
    // The whole point: a calendar frame would describe a period that mostly
    // predates the log, since the log has no backfill.
    expect(rollingRange("2026-03-01").from).toBe("2025-03-02");
  });
});

describe("windowing", () => {
  it("excludes events older than the window", () => {
    const data = computeYir(
      input({
        "2024-01-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:old", m: 600 })],
        "2026-08-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:new", m: 600 })],
      }),
    );
    expect(data.tally.movies).toBe(1);
    expect(data.activeDays).toBe(1);
  });

  it("includes the boundary day itself", () => {
    const data = computeYir(
      input({ "2025-08-12": [ev({ k: WATCH_KIND.MOVIE, t: "movie:edge", m: 600 })] }),
    );
    expect(data.tally.movies).toBe(1);
  });
});

describe("the bulk problem — the reason this feature was designed the way it was", () => {
  /** 33 episodes marked in one click, all sharing minute 283, plus two real
   *  viewings. Modelled on the real log this feature was designed against. */
  const bulkHeavy = input(
    {
      "2026-07-31": [
        ev({ k: WATCH_KIND.MOVIE, t: "movie:a", m: 250 }),
        ev({ k: WATCH_KIND.MOVIE, t: "movie:b", m: 280 }),
        ...Array.from({ length: 33 }, (_, i) =>
          ev({ k: WATCH_KIND.EPISODE, t: "tv:st", s: 1, e: i + 1, m: 283, b: 1 }),
        ),
      ],
    },
    [movie("a", "A", 1990, ["Drama"]), movie("b", "B", 2000, ["Comedy"]), tv("st", "ST", 2016, ["Sci-Fi"])],
  );

  it("does not report a rhythm built from one click", () => {
    // Naively this log says "you watch most at 4am, 35 events". Only 2 of
    // those events describe a real viewing time, which is below the sample
    // floor — so no rhythm card at all, rather than a confident lie.
    const data = computeYir(bulkHeavy);
    expect(data.rhythm).toBeNull();
    expect(selectCards(data)).not.toContain("rhythm");
  });

  it("still counts bulk episodes in the tally — they WERE watched", () => {
    // Excluding them from rhythm is about when, not whether.
    expect(computeYir(bulkHeavy).tally.episodes).toBe(33);
  });

  it("reports how many events could not describe a time", () => {
    expect(computeYir(bulkHeavy).provenance.bulkEvents).toBe(33);
  });

  it("does not let one binge dominate genre or decade counts", () => {
    // 33 events for one show must count as ONE title, or a single binge
    // drowns out everything else watched all year.
    const data = computeYir(bulkHeavy);
    expect(data.decades?.count).toBe(3);
    expect(data.genres?.distinctGenres).toBe(3);
  });
});

describe("rhythm", () => {
  function timedDays(count: number, minute: number): Record<DayKey, WatchLogDay> {
    const days: Record<DayKey, WatchLogDay> = {};
    for (let i = 0; i < count; i++) {
      days[`2026-07-${String(i + 1).padStart(2, "0")}`] = [
        ev({ k: WATCH_KIND.MOVIE, t: "movie:x", m: minute }),
      ];
    }
    return days;
  }

  it("is withheld below the sample floor", () => {
    expect(computeYir(input(timedDays(4, 1290))).rhythm).toBeNull();
  });

  it("reports a peak once there is enough real data", () => {
    const data = computeYir(input(timedDays(10, 1290)));
    expect(data.rhythm?.peakHour).toBe(21);
    expect(data.rhythm?.sampleSize).toBe(10);
  });

  it("ignores untimed imported events", () => {
    // An IMDb/Letterboxd row has a date but no clock time. Counting it as
    // midnight would invent a spike.
    const days = timedDays(10, 1290);
    days["2026-06-01"] = Array.from({ length: 50 }, () => ev({ k: WATCH_KIND.MOVIE, t: "movie:i" }));
    const data = computeYir(input(days));
    expect(data.rhythm?.peakHour).toBe(21);
    expect(data.rhythm?.sampleSize).toBe(10);
  });
});

describe("critics — the card people actually share", () => {
  // The real numbers this feature was designed against.
  const entries = [
    movie("spirited", "Spirited Away", 2001, ["Animation"], 8.6),
    movie("parasite", "Parasite", 2019, ["Thriller"], 8.5),
    movie("dtrt", "Do the Right Thing", 1989, ["Drama"], 7.9),
    movie("shawshank", "Shawshank", 1994, ["Drama"], 9.3),
    movie("godfather", "The Godfather", 1972, ["Crime"], 9.2),
  ];
  const ratings = [
    rated("spirited", "movie", 69),
    rated("parasite", "movie", 70),
    rated("dtrt", "movie", 67),
    rated("shawshank", "movie", 87),
    rated("godfather", "movie", 95, "a private note that must never surface"),
  ];
  const days: Record<DayKey, WatchLogDay> = {
    "2026-08-01": entries.map((e) => ev({ k: WATCH_KIND.MOVIE, t: `movie:${e.id}`, m: 1200 })),
  };

  it("identifies a tough critic and the film they were kind to", () => {
    const critics = computeYir(input(days, entries, ratings)).critics;
    expect(critics?.persona).toBe("tough");
    expect(critics?.gap).toBeCloseTo(-9.4, 1);
    expect(critics?.outlier?.name).toBe("The Godfather");
    expect(critics?.deltas[0].name).toBe("Spirited Away"); // biggest disagreement
  });

  it("NEVER exposes a private note", () => {
    // The single hardest privacy line in this feature: notes are local-only
    // and this data reaches a shareable image.
    const serialized = JSON.stringify(computeYir(input(days, entries, ratings)));
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain("note");
  });

  it("compares over the SAME titles, never mismatched populations", () => {
    // A rating with no crowd score to compare against is dropped from BOTH
    // averages — the fairness rule the Contrarian badge established.
    const withUnrated = [...entries, movie("obscure", "Obscure", 2020, ["Drama"], null)];
    const withRating = [...ratings, rated("obscure", "movie", 10)];
    const allDays: Record<DayKey, WatchLogDay> = {
      "2026-08-01": withUnrated.map((e) => ev({ k: WATCH_KIND.MOVIE, t: `movie:${e.id}`, m: 1200 })),
    };
    const critics = computeYir(input(allDays, withUnrated, withRating)).critics;
    expect(critics?.deltas).toHaveLength(5);
  });

  it("is withheld below the sample floor", () => {
    const two = entries.slice(0, 2);
    const twoDays: Record<DayKey, WatchLogDay> = {
      "2026-08-01": two.map((e) => ev({ k: WATCH_KIND.MOVIE, t: `movie:${e.id}`, m: 1200 })),
    };
    expect(computeYir(input(twoDays, two, ratings.slice(0, 2))).critics).toBeNull();
  });

  it("only counts titles watched IN RANGE", () => {
    // Otherwise this is a lifetime stat wearing a 12-month label.
    const old: Record<DayKey, WatchLogDay> = {
      "2024-01-01": entries.map((e) => ev({ k: WATCH_KIND.MOVIE, t: `movie:${e.id}`, m: 1200 })),
    };
    expect(computeYir(input(old, entries, ratings)).critics).toBeNull();
  });

  it("reports no outlier when the whole set leans one way", () => {
    const uniform = entries.slice(0, 4);
    const harsh = uniform.map((e) => rated(e.id, "movie", 50));
    const uniformDays: Record<DayKey, WatchLogDay> = {
      "2026-08-01": uniform.map((e) => ev({ k: WATCH_KIND.MOVIE, t: `movie:${e.id}`, m: 1200 })),
    };
    expect(computeYir(input(uniformDays, uniform, harsh)).critics?.outlier).toBeNull();
  });
});

describe("the thin year", () => {
  const sixThings = input(
    {
      "2026-03-02": [ev({ k: WATCH_KIND.MOVIE, t: "movie:a", m: 1200 })],
      "2026-05-09": [ev({ k: WATCH_KIND.MOVIE, t: "movie:b", m: 1200 })],
      "2026-07-14": [ev({ k: WATCH_KIND.MOVIE, t: "movie:c", m: 1200 })],
    },
    [
      movie("a", "Jaws", 1975, ["Thriller"]),
      movie("b", "Akira", 1988, ["Animation"]),
      movie("c", "Dune", 2021, ["Sci-Fi"]),
    ],
  );

  it("still produces a real deck from three films", () => {
    const data = computeYir(sixThings);
    const cards = selectCards(data);
    expect(cards).toContain("decades");
    expect(cards).toContain("genres");
    expect(cards.length).toBeGreaterThanOrEqual(4);
  });

  it("leans on distribution, which survives what volume does not", () => {
    const data = computeYir(sixThings);
    expect(data.decades?.count).toBe(3);
    expect(data.decades?.oldestYear).toBe(1975);
    expect(isThinYear(data)).toBe(true);
  });

  it("finds a headline that leans INTO the thinness rather than apologising", () => {
    // "Three decades in three titles" is a better line than any volume stat
    // available here, precisely because the count is small. Pinned because a
    // first draft fell through every rung to "A year of watching" — the
    // blandest possible line, for the most common year-one user.
    expect(headlineFor(computeYir(sixThings))).toBe("Three decades in 3 titles");
  });

  it("does not use the thin framing once the year is not thin", () => {
    // "Three decades in ninety films" is not a boast.
    const many: Record<DayKey, WatchLogDay> = {
      "2026-08-01": Array.from({ length: 30 }, (_, i) =>
        ev({ k: WATCH_KIND.MOVIE, t: `movie:m${i}`, m: 1200 }),
      ),
    };
    const entries = Array.from({ length: 30 }, (_, i) =>
      movie(`m${i}`, `M${i}`, 1975 + i, ["Drama"]),
    );
    expect(headlineFor(computeYir(input(many, entries)))).not.toContain("decades in");
  });

  it("omits cards it cannot support instead of showing empty ones", () => {
    const cards = selectCards(computeYir(sixThings));
    expect(cards).not.toContain("rhythm");
    expect(cards).not.toContain("critics");
    expect(cards).not.toContain("topShow");
  });
});

describe("the empty case", () => {
  it("produces a deck rather than throwing", () => {
    const data = computeYir(input({}));
    expect(selectCards(data)).toEqual(["opener", "closer"]);
    expect(data.tally.movies).toBe(0);
    expect(headlineFor(data)).toBe("A year of watching");
  });
});

describe("the importer case", () => {
  it("flags a range dominated by untimed events", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-02-01": Array.from({ length: 40 }, () => ev({ k: WATCH_KIND.MOVIE, t: "movie:i" })),
      "2026-08-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:live", m: 1200 })],
    };
    const data = computeYir(input(days));
    expect(data.provenance.importDominated).toBe(true);
    expect(data.provenance.timedEvents).toBe(1);
  });

  it("does not flag an ordinary live year", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": Array.from({ length: 10 }, () => ev({ k: WATCH_KIND.MOVIE, t: "movie:x", m: 1200 })),
    };
    expect(computeYir(input(days)).provenance.importDominated).toBe(false);
  });
});

describe("hours are honest about being estimates", () => {
  it("suppresses the hours line when almost nothing has a real runtime", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": Array.from({ length: 20 }, (_, i) =>
        ev({ k: WATCH_KIND.EPISODE, t: "tv:x", s: 1, e: i + 1, m: 1200 }),
      ),
    };
    const data = computeYir(input(days, [tv("x", "X", 2020, ["Drama"])]));
    expect(data.tally.runtimeConfidence).toBe(0);
    expect(showsHours(data)).toBe(false);
  });

  it("counts a real movie runtime as known", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:a", m: 1200 })],
    };
    const data = computeYir(input(days, [movie("a", "A", 2000, ["Drama"], null, 175)]));
    expect(data.tally.runtimeConfidence).toBe(1);
    expect(data.tally.approxHours).toBe(3);
  });

  it("does not invent runtime for a coarse whole-show mark", () => {
    // We genuinely do not know how many episodes it stood for.
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": [ev({ k: WATCH_KIND.TITLE, t: "tv:x", m: 1200 })],
    };
    const data = computeYir(input(days, [tv("x", "X", 2020, ["Drama"])]));
    expect(data.tally.shows).toBe(1);
    expect(data.tally.approxHours).toBe(0);
  });
});

describe("join failures degrade rather than break", () => {
  it("survives an event whose title is no longer tracked", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:untracked", m: 1200 })],
    };
    const data = computeYir(input(days, []));
    expect(data.tally.movies).toBe(1);
    expect(data.decades).toBeNull();
    expect(data.genres).toBeNull();
  });

  it("shows no top-show card rather than a raw id", () => {
    const days: Record<DayKey, WatchLogDay> = {
      "2026-08-01": Array.from({ length: 5 }, (_, i) =>
        ev({ k: WATCH_KIND.EPISODE, t: "tv:gone", s: 1, e: i + 1, m: 1200 }),
      ),
    };
    expect(computeYir(input(days, [])).topShow).toBeNull();
  });
});

describe("streaks and months", () => {
  it("finds the longest consecutive run", () => {
    const data = computeYir(
      input({
        "2026-08-01": [ev({ k: WATCH_KIND.MOVIE, t: "movie:a", m: 1 })],
        "2026-08-02": [ev({ k: WATCH_KIND.MOVIE, t: "movie:b", m: 1 })],
        "2026-08-03": [ev({ k: WATCH_KIND.MOVIE, t: "movie:c", m: 1 })],
        "2026-08-09": [ev({ k: WATCH_KIND.MOVIE, t: "movie:d", m: 1 })],
      }),
    );
    expect(data.longestStreak).toBe(3);
    expect(data.activeDays).toBe(4);
    expect(data.busiestMonth).toBe("2026-08");
  });
});
