import type { Episode, Season } from "../types";

interface ShowEpisodeData {
  seasons: Season[];
  episodesBySeason: Record<number, Episode[]>;
}

function ep(
  showId: string,
  seasonNumber: number,
  episodeNumber: number,
  name: string,
  overview: string,
  airDate: string,
  runtimeMinutes: number,
): Episode {
  return {
    id: `${showId}-s${String(seasonNumber).padStart(2, "0")}e${String(
      episodeNumber,
    ).padStart(2, "0")}`,
    seasonNumber,
    episodeNumber,
    name,
    overview,
    airDate,
    runtimeMinutes,
    stillUrl: null,
  };
}

/**
 * Full hand-authored season/episode data — kept to 5 shows so this stays
 * hand-maintainable, each earning its place by exercising a distinct shape
 * the Up Next engine (Phase 3) has to handle correctly:
 *
 *   Fleabag        — 2 seasons, fully aired. The baseline "normal" show.
 *   Chernobyl      — 1 season, fully aired. Smallest possible complete show.
 *   The Bear       — currently airing: 3 aired episodes in its latest season
 *                    plus one dated AFTER today, so Up Next has to recognize
 *                    "next episode exists but hasn't aired yet" rather than
 *                    either hiding it or offering it to watch immediately.
 *   Twin Peaks     — has a Season 0 ("Specials"), which real TMDB data
 *                    regularly includes and which naive season-number
 *                    iteration (1..seasonCount) would never surface.
 *   True Detective — status "canceled" with a final season shorter than
 *                    every season before it: "ended mid-season, no more
 *                    episodes coming," as distinct from a show that
 *                    completed a normal-length final season.
 *
 * Episode counts for these 5 are deliberately smaller than these shows' real
 * runs (e.g. the real Bear seasons run 8-10 episodes, not 3) — hand-authoring
 * a genuine per-episode name/overview/date/runtime for every one of a show's
 * real ~200+ episodes has no test value over doing it for 3, and this file
 * is meant to stay reviewable. Season/premiere dates, status, and the
 * specific "shape" each show demonstrates are otherwise real or realistic.
 *
 * Every other TV title in the catalog falls into one of two tiers, both
 * handled in ./index.ts rather than here:
 *
 *   - Shows with a SEASON_SHAPES entry (Breaking Bad, The Wire, Stranger
 *     Things, The Office, Game of Thrones, Avatar: The Last Airbender) get
 *     their REAL per-season episode counts and premiere dates — because
 *     "wildly different episode counts per season" is a real, well-known
 *     fact about most of these shows, not something worth fabricating — but
 *     individual episodes within each season are still synthesized
 *     generically (see synthesizeEpisodes). This is what lets a 9-season,
 *     201-episode show sit in the catalog without hand-writing 201 records.
 *   - Grey's Anatomy has neither a SEASON_SHAPES entry nor an entry here —
 *     it's the fully generic fallback (naive even split across 20 seasons),
 *     left as-is on purpose as the "nothing special about this one" control.
 */
export const MOCK_EPISODES: Record<string, ShowEpisodeData> = {
  fleabag: {
    seasons: [
      {
        seasonNumber: 1,
        name: "Season 1",
        overview:
          "Fleabag runs a failing guinea-pig-themed café in London and narrates her way through grief, bad sex, and a fractured family.",
        episodeCount: 6,
        airDate: "2016-07-21",
        posterUrl: null,
      },
      {
        seasonNumber: 2,
        name: "Season 2",
        overview:
          "A year on, a family dinner to announce her father's engagement throws Fleabag together with a priest she can't stop noticing.",
        episodeCount: 6,
        airDate: "2019-03-04",
        posterUrl: null,
      },
    ],
    episodesBySeason: {
      1: [
        ep(
          "fleabag",
          1,
          1,
          "Episode 1",
          "Fleabag deflects a bad date and a worse week with a joke and a knowing look at the camera.",
          "2016-07-21",
          24,
        ),
        ep(
          "fleabag",
          1,
          2,
          "Episode 2",
          "A tense family dinner puts Fleabag, her sister Claire, and their father in the same room for the first time in months.",
          "2016-07-28",
          23,
        ),
        ep(
          "fleabag",
          1,
          3,
          "Episode 3",
          "The café's finances come to a head as Fleabag tries to keep the business — and herself — from collapsing.",
          "2016-08-04",
          24,
        ),
        ep(
          "fleabag",
          1,
          4,
          "Episode 4",
          "A silent retreat with her godmother and soon-to-be stepmother goes about as well as Fleabag expected.",
          "2016-08-11",
          23,
        ),
        ep(
          "fleabag",
          1,
          5,
          "Episode 5",
          "A flashback peels back exactly what happened with her best friend Boo, and why Fleabag can't forgive herself for it.",
          "2016-08-18",
          25,
        ),
        ep(
          "fleabag",
          1,
          6,
          "Episode 6",
          "Everything Fleabag has been avoiding all season catches up with her at once.",
          "2016-08-25",
          26,
        ),
      ],
      2: [
        ep(
          "fleabag",
          2,
          1,
          "Episode 1",
          "A blood-soaked family dinner announces her father's engagement — and introduces the priest officiating the wedding.",
          "2019-03-04",
          30,
        ),
        ep(
          "fleabag",
          2,
          2,
          "Episode 2",
          "Fleabag and the priest keep finding excuses to end up in the same room.",
          "2019-03-11",
          27,
        ),
        ep(
          "fleabag",
          2,
          3,
          "Episode 3",
          "Claire's marriage frays in public at the worst possible moment.",
          "2019-03-18",
          26,
        ),
        ep(
          "fleabag",
          2,
          4,
          "Episode 4",
          "A trip to a religious retreat forces Fleabag to sit still with feelings she'd rather joke away.",
          "2019-03-25",
          28,
        ),
        ep(
          "fleabag",
          2,
          5,
          "Episode 5",
          "The night before the wedding brings Fleabag and the priest to a decision neither of them can walk back.",
          "2019-04-01",
          30,
        ),
        ep(
          "fleabag",
          2,
          6,
          "Episode 6",
          "The wedding forces every unresolved relationship in Fleabag's life into the same room at once.",
          "2019-04-08",
          33,
        ),
      ],
    },
  },
  chernobyl: {
    seasons: [
      {
        seasonNumber: 1,
        name: "Season 1",
        overview:
          "The explosion at Reactor 4 and the scientists, miners, and officials who spend the following months containing it and uncovering why it happened.",
        episodeCount: 5,
        airDate: "2019-05-06",
        posterUrl: null,
      },
    ],
    episodesBySeason: {
      1: [
        ep(
          "chernobyl",
          1,
          1,
          "1:23:45",
          "A reactor test goes catastrophically wrong in the middle of the night, and the men on shift underestimate exactly how badly.",
          "2019-05-06",
          62,
        ),
        ep(
          "chernobyl",
          1,
          2,
          "Please Remain Calm",
          "Valery Legasov is brought in to explain a disaster that officials would rather downplay than understand.",
          "2019-05-13",
          61,
        ),
        ep(
          "chernobyl",
          1,
          3,
          "Open Wounds",
          "The scale of the contamination forces an evacuation and an increasingly desperate containment effort.",
          "2019-05-20",
          72,
        ),
        ep(
          "chernobyl",
          1,
          4,
          "The Happiness of All Mankind",
          "Miners and soldiers are sent in to do what machines can't, at enormous personal cost.",
          "2019-05-27",
          63,
        ),
        ep(
          "chernobyl",
          1,
          5,
          "Vichnaya Pamyat",
          "At trial, Legasov must decide whether to tell the truth about what really caused the disaster.",
          "2019-06-03",
          66,
        ),
      ],
    },
  },

  "the-bear": {
    seasons: [
      {
        seasonNumber: 1,
        name: "Season 1",
        overview:
          "Carmy returns to Chicago to run his late brother's failing sandwich shop and immediately collides with a kitchen that has no interest in changing how it works.",
        episodeCount: 3,
        airDate: "2022-06-23",
        posterUrl: null,
      },
      {
        seasonNumber: 2,
        name: "Season 2",
        overview:
          "A full renovation and a real menu give the crew a shot at becoming something worth the name — if the shop survives long enough to open.",
        episodeCount: 3,
        airDate: "2023-06-22",
        posterUrl: null,
      },
      {
        seasonNumber: 3,
        name: "Season 3",
        overview:
          "Carmy replays every mistake from opening night while a blistering review forces the question of whether he can actually run this place.",
        episodeCount: 3,
        airDate: "2024-06-27",
        posterUrl: null,
      },
      {
        // Invented for this mock catalog — see the note in ./episodes.ts.
        seasonNumber: 4,
        name: "Season 4",
        overview:
          "A new investor's ultimatum forces the kitchen to prove, service by service, that the restaurant can actually turn a profit.",
        episodeCount: 4,
        airDate: "2026-06-24",
        posterUrl: null,
      },
    ],
    episodesBySeason: {
      1: [
        ep(
          "the-bear",
          1,
          1,
          "System",
          "Carmy inherits his brother's chaotic Chicago sandwich shop and immediately clashes with a kitchen crew that has no interest in his methods.",
          "2022-06-23",
          30,
        ),
        ep(
          "the-bear",
          1,
          2,
          "Hands",
          "A broken hand sink becomes the flashpoint for Carmy's demand that the kitchen finally meet code.",
          "2022-06-23",
          33,
        ),
        ep(
          "the-bear",
          1,
          3,
          "Braciole",
          "A frantic dinner service collapses into a walk-in freezer confrontation that forces Carmy to reckon with what he actually wants.",
          "2022-06-23",
          40,
        ),
      ],
      2: [
        ep(
          "the-bear",
          2,
          1,
          "Beef",
          "Carmy commits to a full renovation and a real menu, betting the shop's future on becoming something worth the name.",
          "2023-06-22",
          33,
        ),
        ep(
          "the-bear",
          2,
          2,
          "Fishes",
          "A chaotic, years-earlier Christmas dinner reveals exactly where this family's damage comes from.",
          "2023-06-22",
          66,
        ),
        ep(
          "the-bear",
          2,
          3,
          "Doors",
          "Opening night arrives with half the kitchen unfinished and every relationship in the building at a breaking point.",
          "2023-06-22",
          40,
        ),
      ],
      3: [
        ep(
          "the-bear",
          3,
          1,
          "Tomorrow",
          "Carmy replays every mistake from the restaurant's opening while the new menu quietly falls apart around him.",
          "2024-06-27",
          34,
        ),
        ep(
          "the-bear",
          3,
          2,
          "Ice Chips",
          "A tense hospital waiting room forces two estranged family members into the conversation they've avoided for years.",
          "2024-06-27",
          39,
        ),
        ep(
          "the-bear",
          3,
          3,
          "Forever",
          "A blistering review lands the same week Carmy has to decide whether he can actually run this place at all.",
          "2024-06-27",
          42,
        ),
      ],
      4: [
        ep(
          "the-bear",
          4,
          1,
          "Proof",
          "A new investor's ultimatum forces the whole kitchen to prove the restaurant can actually turn a profit.",
          "2026-06-24",
          36,
        ),
        ep(
          "the-bear",
          4,
          2,
          "Line",
          "Carmy rebuilds the pass from scratch, and the crew has to relearn how to work under him all over again.",
          "2026-07-01",
          38,
        ),
        ep(
          "the-bear",
          4,
          3,
          "Weeds",
          "A packed Saturday service buries the kitchen just as an old rival chef walks in for a reservation.",
          "2026-07-15",
          41,
        ),
        // Not yet aired as of "today" in this app (2026-07-29) — this is the
        // "currently airing, next episode date in the future" test case.
        ep(
          "the-bear",
          4,
          4,
          "Second Service",
          "Carmy has to decide, in real time, whether tonight's service is the one that finally works.",
          "2026-08-05",
          44,
        ),
      ],
    },
  },

  "twin-peaks": {
    seasons: [
      {
        seasonNumber: 1,
        name: "Season 1",
        overview:
          "Agent Cooper arrives in Twin Peaks to investigate Laura Palmer's murder and finds a town with far more secrets than the case alone.",
        episodeCount: 4,
        airDate: "1990-04-08",
        posterUrl: null,
      },
      {
        seasonNumber: 2,
        name: "Season 2",
        overview:
          "The hunt for Laura's killer reaches its answer around the season's midpoint, and the back half follows the town — and Cooper — somewhere much stranger.",
        episodeCount: 5,
        airDate: "1990-09-30",
        posterUrl: null,
      },
      {
        // A Season 0 "Specials" bucket — real TMDB data for many shows
        // includes exactly this, and naive 1..seasonCount iteration would
        // never surface it. Deliberately excluded from the catalog's
        // episodeCount — see the note on the twin-peaks entry in catalog.ts.
        seasonNumber: 0,
        name: "Specials",
        overview:
          "Bonus material from the show's original run and later home-video releases.",
        episodeCount: 2,
        airDate: "2007-10-02",
        posterUrl: null,
      },
    ],
    episodesBySeason: {
      1: [
        ep(
          "twin-peaks",
          1,
          1,
          "Northwest Passage",
          "Laura Palmer's body washes up wrapped in plastic, and Agent Cooper arrives to find the whole town hiding something.",
          "1990-04-08",
          94,
        ),
        ep(
          "twin-peaks",
          1,
          2,
          "Traces to Nowhere",
          "Cooper's investigation turns up more suspects than answers as the town's secrets start to surface.",
          "1990-04-12",
          45,
        ),
        ep(
          "twin-peaks",
          1,
          3,
          "Zen, or the Skill to Catch a Killer",
          "A dream sends Cooper's investigation somewhere his usual methods can't fully explain.",
          "1990-04-19",
          45,
        ),
        ep(
          "twin-peaks",
          1,
          4,
          "Rest in Pain",
          "Laura's funeral brings the whole town's grief and suspicion into the same room at once.",
          "1990-04-26",
          45,
        ),
      ],
      2: [
        ep(
          "twin-peaks",
          2,
          1,
          "May the Giant Be With You",
          "Cooper survives the shooting that ended the previous season, guided by a vision that points toward the killer.",
          "1990-09-30",
          45,
        ),
        ep(
          "twin-peaks",
          2,
          2,
          "Coma",
          "A witness wakes from a coma with a piece of the truth Cooper needs, if anyone can get it out of her.",
          "1990-10-06",
          45,
        ),
        ep(
          "twin-peaks",
          2,
          3,
          "Dead Dog Farm",
          "A drug-running side plot collides with the murder investigation in the woods outside town.",
          "1990-11-10",
          45,
        ),
        ep(
          "twin-peaks",
          2,
          4,
          "Arbitrary Law",
          "The killer's identity is finally confirmed, and it's someone the town never suspected.",
          "1990-12-01",
          45,
        ),
        ep(
          "twin-peaks",
          2,
          5,
          "Beyond Life and Death",
          "Cooper follows the case into the Black Lodge and doesn't come back the same.",
          "1991-06-10",
          45,
        ),
      ],
      0: [
        ep(
          "twin-peaks",
          0,
          1,
          "Return to the Red Room",
          "A retrospective look back at the show's original run, with cast and crew reflecting on what made it so strange.",
          "2007-10-02",
          22,
        ),
        ep(
          "twin-peaks",
          0,
          2,
          "The Log Lady Introductions",
          "A collection of the in-character introductions filmed for the show's original syndication run.",
          "2014-07-29",
          15,
        ),
      ],
    },
  },

  "true-detective": {
    seasons: [
      {
        seasonNumber: 1,
        name: "Season 1",
        overview:
          "Two Louisiana detectives revisit a 1995 ritualistic murder neither of them ever fully let go of.",
        episodeCount: 4,
        airDate: "2014-01-12",
        posterUrl: null,
      },
      {
        seasonNumber: 2,
        name: "Season 2",
        overview:
          "A city manager's murder pulls four compromised investigators into the same corrupt California jurisdiction.",
        episodeCount: 4,
        airDate: "2015-06-21",
        posterUrl: null,
      },
      {
        seasonNumber: 3,
        name: "Season 3",
        overview:
          "A 1980 disappearance in the Ozarks is reopened decades later by a detective who never stopped working it privately.",
        episodeCount: 4,
        airDate: "2019-01-13",
        posterUrl: null,
      },
      {
        // Shorter than every season before it, and no season 5 follows —
        // see the note on the true-detective entry in catalog.ts.
        seasonNumber: 4,
        name: "Night Country",
        overview:
          "Eight men vanish from an Arctic research station on the first day of total winter darkness.",
        episodeCount: 2,
        airDate: "2024-01-14",
        posterUrl: null,
      },
    ],
    episodesBySeason: {
      1: [
        ep(
          "true-detective",
          1,
          1,
          "The Long Bright Dark",
          "Two Louisiana detectives recall a 1995 ritualistic murder that neither of them ever fully let go of.",
          "2014-01-12",
          58,
        ),
        ep(
          "true-detective",
          1,
          2,
          "Seeing Things",
          "Cohle's off-the-books methods put him at odds with everyone assigned to work the case alongside him.",
          "2014-01-19",
          56,
        ),
        ep(
          "true-detective",
          1,
          3,
          "The Secret Fate of All Life",
          "The investigation's official version of events starts to diverge sharply from what actually happened.",
          "2014-02-02",
          51,
        ),
        ep(
          "true-detective",
          1,
          4,
          "Form and Void",
          "Seventeen years later, Cohle and Hart follow the case into the one place they'd both hoped never to go back to.",
          "2014-03-09",
          53,
        ),
      ],
      2: [
        ep(
          "true-detective",
          2,
          1,
          "The Western Book of the Dead",
          "A city manager's murder pulls four compromised investigators into the same corrupt jurisdiction.",
          "2015-06-21",
          63,
        ),
        ep(
          "true-detective",
          2,
          2,
          "Night Finds You",
          "Each detective's own history starts working against the case as much as for it.",
          "2015-06-28",
          58,
        ),
        ep(
          "true-detective",
          2,
          3,
          "Down Will Come",
          "A shootout leaves the investigation with more bodies and fewer answers than it started with.",
          "2015-07-12",
          58,
        ),
        ep(
          "true-detective",
          2,
          4,
          "Omega Station",
          "The four investigators close in on the truth just as it becomes clear who's willing to bury it.",
          "2015-08-09",
          60,
        ),
      ],
      3: [
        ep(
          "true-detective",
          3,
          1,
          "The Great War and Modern Memory",
          "A 1980 disappearance in the Ozarks is reopened decades later by a detective who never stopped working it privately.",
          "2019-01-13",
          62,
        ),
        ep(
          "true-detective",
          3,
          2,
          "Kiss Tomorrow Goodbye",
          "A discovery in the woods reframes the case as something far worse than a simple abduction.",
          "2019-01-20",
          53,
        ),
        ep(
          "true-detective",
          3,
          3,
          "The Big Never",
          "Old interview tapes from the original investigation surface, and they don't match the official story.",
          "2019-02-03",
          50,
        ),
        ep(
          "true-detective",
          3,
          4,
          "Now Am Found",
          "The detective's decades-long private pursuit of the case finally catches up with the truth.",
          "2019-02-24",
          74,
        ),
      ],
      4: [
        ep(
          "true-detective",
          4,
          1,
          "Night Country: Part One",
          "Eight men vanish from an Arctic research station on the first day of total winter darkness.",
          "2024-01-14",
          58,
        ),
        // The last episode produced — no season 5 follows. See catalog.ts.
        ep(
          "true-detective",
          4,
          2,
          "Night Country: Part Two",
          "The investigation stalls out just as the case is quietly shelved for good.",
          "2024-01-21",
          52,
        ),
      ],
    },
  },
};
