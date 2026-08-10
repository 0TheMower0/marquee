import { describe, expect, it } from "vitest";

import type { Episode, Title } from "@/lib/content/types";

import { detectEvents, snapshotOf, type ShowSnapshot } from "./detect";

const FUTURE = "2099-01-01";
const PAST = "2020-01-01";

function ep(seasonNumber: number, episodeNumber: number, airDate: string | null, name = "Ep"): Episode {
  return {
    id: `s${seasonNumber}e${episodeNumber}`,
    seasonNumber,
    episodeNumber,
    name,
    overview: "",
    airDate,
    runtimeMinutes: null,
    stillUrl: null,
  };
}

function title(overrides: Partial<Title> = {}): Title {
  return {
    id: "breaking-bad",
    mediaType: "tv",
    name: "Breaking Bad",
    year: 2008,
    overview: "",
    genres: [],
    posterUrl: null,
    placeholder: { gradientFrom: "#111", gradientTo: "#222" },
    rating: null,
    originalName: null,
    backdropUrl: null,
    status: null,
    runtimeMinutes: null,
    seasonCount: 5,
    episodeCount: 62,
    cast: [],
    crew: [],
    lastEpisodeToAir: ep(5, 16, PAST),
    nextEpisodeToAir: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ShowSnapshot> = {}): ShowSnapshot {
  return {
    showId: "breaking-bad",
    lastEpisodeKey: "s5e16",
    latestSeason: 5,
    seasonsCount: 5,
    ...overrides,
  };
}

describe("detectEvents — no baseline, no events", () => {
  it("emits NOTHING on a show's first ever sighting", () => {
    // The failure this prevents: the first run after deploy notifying every
    // user about every show they follow, all at once.
    const result = detectEvents(title(), null);
    expect(result.events).toEqual([]);
  });

  it("still records the snapshot on that first sighting", () => {
    const result = detectEvents(title(), null);
    expect(result.snapshot.lastEpisodeKey).toBe("s5e16");
    expect(result.snapshot.seasonsCount).toBe(5);
  });
});

describe("detectEvents — episode_aired", () => {
  it("emits nothing when nothing changed", () => {
    expect(detectEvents(title(), snapshot()).events).toEqual([]);
  });

  it("emits one event when a new episode has aired", () => {
    const next = title({ lastEpisodeToAir: ep(6, 1, PAST, "Pilot") });
    const events = detectEvents(next, snapshot()).events;
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("episode_aired");
    expect(events[0].eventKey).toBe("s6e1");
  });

  it("NEVER emits for an episode that has not aired yet", () => {
    // The invariant that matters most: this would say "it's out" before it is.
    const next = title({ lastEpisodeToAir: ep(6, 1, FUTURE) });
    expect(detectEvents(next, snapshot()).events).toEqual([]);
  });

  it("collapses a full-season drop into ONE event, not eight", () => {
    // Eight separate pushes is exactly the noise that gets notifications
    // switched off entirely.
    const next = title({
      id: "severance",
      name: "Severance",
      lastEpisodeToAir: ep(2, 8, PAST),
    });
    const events = detectEvents(next, snapshot({ showId: "severance", lastEpisodeKey: "s2e0" })).events;
    expect(events).toHaveLength(1);
    expect(events[0].payload.body).toContain("8 new episodes");
  });

  it("understates rather than overstates across a season boundary", () => {
    // Counting across seasons would need every intervening season's episode
    // count. Saying "new episode" when 12 aired beats claiming "12" when 3 did.
    const next = title({ lastEpisodeToAir: ep(6, 3, PAST) });
    const events = detectEvents(next, snapshot({ lastEpisodeKey: "s5e16" })).events;
    expect(events[0].payload.body).not.toContain("new episodes");
  });

  it("keys on the newest episode so a repeat detection dedups", () => {
    const next = title({ lastEpisodeToAir: ep(6, 1, PAST) });
    const first = detectEvents(next, snapshot()).events[0];
    // Same fetch, snapshot not yet written (a crash between the two) — the key
    // must be identical so the unique constraint recognises it.
    const second = detectEvents(next, snapshot()).events[0];
    expect(first.eventKey).toBe(second.eventKey);
  });
});

describe("detectEvents — season_announced", () => {
  it("emits when the season count increases", () => {
    const next = title({ seasonCount: 6 });
    const events = detectEvents(next, snapshot()).events;
    const season = events.find((event) => event.kind === "season_announced");
    expect(season?.eventKey).toBe("season:6");
  });

  it("does not emit when the count is unchanged or lower", () => {
    expect(detectEvents(title({ seasonCount: 5 }), snapshot()).events).toEqual([]);
    // A provider correction downward is not an announcement.
    expect(detectEvents(title({ seasonCount: 4 }), snapshot()).events).toEqual([]);
  });

  it("does not announce every season when the previous reading was absent", () => {
    // A snapshot written before this field existed has null, which means "no
    // reading" — treating it as 0 would announce season 5 of a five-year-old
    // show as news.
    const events = detectEvents(title(), snapshot({ seasonsCount: null })).events;
    expect(events.find((event) => event.kind === "season_announced")).toBeUndefined();
  });

  it("can emit alongside an episode event", () => {
    const next = title({ seasonCount: 6, lastEpisodeToAir: ep(6, 1, PAST) });
    const kinds = detectEvents(next, snapshot()).events.map((event) => event.kind);
    expect(kinds).toContain("episode_aired");
    expect(kinds).toContain("season_announced");
  });
});

describe("snapshotOf", () => {
  it("refuses to record an unaired episode as the last aired one", () => {
    // If it did, the real notification would be permanently suppressed when
    // that episode actually airs — the key would already match.
    const snap = snapshotOf(title({ lastEpisodeToAir: ep(6, 1, FUTURE) }));
    expect(snap.lastEpisodeKey).toBeNull();
  });

  it("records a null air date as aired, matching isFutureAirDate", () => {
    const snap = snapshotOf(title({ lastEpisodeToAir: ep(6, 1, null) }));
    expect(snap.lastEpisodeKey).toBe("s6e1");
  });
});

describe("the world-fact rule, as a structural property", () => {
  it("takes no watch data at all — the §1.1 test passes by construction", () => {
    // detectEvents' entire signature is (Title, ShowSnapshot | null). There is
    // no user, no watch progress, no last-opened timestamp in scope. A
    // behaviour-triggered notification is not expressible here, which is the
    // point: suppression lives elsewhere, deliberately.
    expect(detectEvents.length).toBe(2);
  });
});
