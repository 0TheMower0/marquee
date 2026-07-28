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
 * Full hand-authored season/episode data for exactly 2 shows — kept small
 * (Fleabag: 2 seasons / 12 episodes; Chernobyl: 1 season / 5 episodes) so
 * this stays hand-maintainable. Every other TV title in the catalog gets its
 * season/episode structure synthesized on the fly from seasonCount /
 * episodeCount (see synthesizeSeasons / synthesizeEpisodes in ./index.ts) —
 * that's what lets a 9- or 20-season show sit in the catalog without
 * requiring hundreds of hand-written episode records.
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
};
