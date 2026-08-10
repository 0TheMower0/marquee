/**
 * ~25 hand-authored titles spanning the 1970s–2020s across 13 genres, with a
 * deliberate mix of movies and long-running TV shows (Grey's Anatomy: 20
 * seasons, The Office: 9, Game of Thrones: 8) so Phase 3's episode-progress
 * work has something realistic to chew on.
 *
 * Titles, years, cast, crew, and season/episode counts are public facts —
 * the kind of metadata any tracker app displays. Overview text is written
 * originally for this project, not copied from any source.
 *
 * `cast`/`crew` live on every entry here because catalog entries back BOTH
 * `Title` (detail) and, via `toSummary()` in ./index.ts, `TitleSummary`
 * (lists) — the summary conversion is what actually drops them for list
 * endpoints. See the note on `Title` in ../types.ts for why that split
 * exists, and do not "fix" toSummary() to include either — that would
 * silently violate the contract tmdbProvider has to honor too (TMDB's list
 * endpoints genuinely have no credits data).
 *
 * `crew` is intentionally thin next to `cast`: movies get a director plus
 * writer(s) (real, verifiable credits), TV shows get only their creator(s) —
 * see the note on `CrewRole` in ../types.ts for why TV doesn't attempt
 * director/writer. Grey's Anatomy's `crew` is deliberately `[]`, the "no
 * crew credited" edge case.
 */
import type { CastMember, CrewMember, CrewRole, Genre, Title, TitleStatus } from "../types";

const G = {
  crime: { id: "crime", name: "Crime" },
  drama: { id: "drama", name: "Drama" },
  thriller: { id: "thriller", name: "Thriller" },
  adventure: { id: "adventure", name: "Adventure" },
  sciFi: { id: "sci-fi", name: "Sci-Fi" },
  horror: { id: "horror", name: "Horror" },
  comedy: { id: "comedy", name: "Comedy" },
  animation: { id: "animation", name: "Animation" },
  fantasy: { id: "fantasy", name: "Fantasy" },
  action: { id: "action", name: "Action" },
  history: { id: "history", name: "History" },
  romance: { id: "romance", name: "Romance" },
  mystery: { id: "mystery", name: "Mystery" },
} satisfies Record<string, Genre>;

function member(
  id: string,
  name: string,
  character: string,
  order: number,
): CastMember {
  return { id, name, character, order, profileUrl: null };
}

function crewMember(id: string, name: string, role: CrewRole): CrewMember {
  return { id, name, role, profileUrl: null };
}

/**
 * Every field of `Title` except the ones DERIVED at read time by `hydrate`:
 *
 * - `placeholder` — deterministic from `id` (see ../shared/placeholder).
 * - `lastEpisodeToAir` / `nextEpisodeToAir` — scanned out of this show's own
 *   episode data (see `airBoundaryFor` in ./index.ts), so they cannot drift
 *   out of sync with `MOCK_EPISODES` / `SEASON_SHAPES` the way a
 *   hand-authored copy silently would.
 */
export type CatalogEntry = Omit<
  Title,
  "placeholder" | "lastEpisodeToAir" | "nextEpisodeToAir"
>;

const RELEASED: TitleStatus = "released";

export const MOCK_CATALOG: CatalogEntry[] = [
  // --- Movies ---------------------------------------------------------
  {
    id: "the-godfather",
    mediaType: "movie",
    name: "The Godfather",
    originalName: null,
    year: 1972,
    overview:
      "A New York crime dynasty transfers control from an aging patriarch to his reluctant youngest son, exposing the cost of power inside the family.",
    genres: [G.crime, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.2,
    runtimeMinutes: 175,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("marlon-brando", "Marlon Brando", "Don Vito Corleone", 0),
      member("al-pacino", "Al Pacino", "Michael Corleone", 1),
      member("james-caan", "James Caan", "Sonny Corleone", 2),
      member("diane-keaton", "Diane Keaton", "Kay Adams", 3),
    ],
    crew: [
      crewMember("francis-ford-coppola", "Francis Ford Coppola", "director"),
      crewMember("mario-puzo", "Mario Puzo", "writer"),
      crewMember("francis-ford-coppola", "Francis Ford Coppola", "writer"),
    ],
  },
  {
    id: "jaws",
    mediaType: "movie",
    name: "Jaws",
    originalName: null,
    year: 1975,
    overview:
      "A police chief, a marine biologist, and a grizzled fisherman hunt a great white shark terrorizing a New England resort town.",
    genres: [G.thriller, G.adventure],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.1,
    runtimeMinutes: 124,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("roy-scheider", "Roy Scheider", "Martin Brody", 0),
      member("robert-shaw", "Robert Shaw", "Quint", 1),
      member("richard-dreyfuss", "Richard Dreyfuss", "Matt Hooper", 2),
    ],
    crew: [
      crewMember("steven-spielberg", "Steven Spielberg", "director"),
      crewMember("peter-benchley", "Peter Benchley", "writer"),
      crewMember("carl-gottlieb", "Carl Gottlieb", "writer"),
    ],
  },
  {
    id: "alien",
    mediaType: "movie",
    name: "Alien",
    originalName: null,
    year: 1979,
    overview:
      "The crew of a deep-space mining ship investigates a distress signal and brings a hostile life form aboard with them.",
    genres: [G.sciFi, G.horror],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.5,
    runtimeMinutes: 117,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("sigourney-weaver", "Sigourney Weaver", "Ellen Ripley", 0),
      member("tom-skerritt", "Tom Skerritt", "Dallas", 1),
      member("ian-holm", "Ian Holm", "Ash", 2),
    ],
    crew: [
      crewMember("ridley-scott", "Ridley Scott", "director"),
      crewMember("dan-obannon", "Dan O'Bannon", "writer"),
    ],
  },
  {
    id: "blade-runner",
    mediaType: "movie",
    name: "Blade Runner",
    originalName: null,
    year: 1982,
    overview:
      "A retired bounty hunter is pulled back into service to track down synthetic humans hiding in a rain-soaked future city.",
    genres: [G.sciFi, G.thriller],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.1,
    runtimeMinutes: 117,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("harrison-ford", "Harrison Ford", "Rick Deckard", 0),
      member("rutger-hauer", "Rutger Hauer", "Roy Batty", 1),
      member("sean-young", "Sean Young", "Rachael", 2),
    ],
    crew: [
      crewMember("ridley-scott", "Ridley Scott", "director"),
      crewMember("hampton-fancher", "Hampton Fancher", "writer"),
      crewMember("david-peoples", "David Peoples", "writer"),
    ],
  },
  {
    id: "do-the-right-thing",
    mediaType: "movie",
    name: "Do the Right Thing",
    originalName: null,
    year: 1989,
    overview:
      "Rising tension on the hottest day of the summer pushes a Brooklyn block toward a reckoning between its Italian-American and Black residents.",
    genres: [G.drama, G.comedy],
    posterUrl: null,
    backdropUrl: null,
    rating: 7.9,
    runtimeMinutes: 120,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("spike-lee", "Spike Lee", "Mookie", 0),
      member("danny-aiello", "Danny Aiello", "Sal", 1),
      member("ruby-dee", "Ruby Dee", "Mother Sister", 2),
    ],
    crew: [
      crewMember("spike-lee", "Spike Lee", "director"),
      crewMember("spike-lee", "Spike Lee", "writer"),
    ],
  },
  {
    id: "pulp-fiction",
    mediaType: "movie",
    name: "Pulp Fiction",
    originalName: null,
    year: 1994,
    overview:
      "The lives of two hitmen, a boxer, and a gangster's wife intertwine across a set of violent, darkly funny stories in Los Angeles.",
    genres: [G.crime, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.9,
    runtimeMinutes: 154,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("john-travolta", "John Travolta", "Vincent Vega", 0),
      member("samuel-l-jackson", "Samuel L. Jackson", "Jules Winnfield", 1),
      member("uma-thurman", "Uma Thurman", "Mia Wallace", 2),
      member("bruce-willis", "Bruce Willis", "Butch Coolidge", 3),
    ],
    crew: [
      crewMember("quentin-tarantino", "Quentin Tarantino", "director"),
      crewMember("quentin-tarantino", "Quentin Tarantino", "writer"),
      crewMember("roger-avary", "Roger Avary", "writer"),
    ],
  },
  {
    id: "the-shawshank-redemption",
    mediaType: "movie",
    name: "The Shawshank Redemption",
    originalName: null,
    year: 1994,
    overview:
      "A banker wrongly convicted of murder builds a quiet, decades-long plan for freedom and friendship inside a brutal Maine prison.",
    genres: [G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.3,
    runtimeMinutes: 142,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("tim-robbins", "Tim Robbins", "Andy Dufresne", 0),
      member("morgan-freeman", "Morgan Freeman", 'Ellis "Red" Redding', 1),
      member("bob-gunton", "Bob Gunton", "Warden Norton", 2),
    ],
    crew: [
      crewMember("frank-darabont", "Frank Darabont", "director"),
      crewMember("frank-darabont", "Frank Darabont", "writer"),
    ],
  },
  {
    id: "spirited-away",
    mediaType: "movie",
    name: "Spirited Away",
    originalName: "千と千尋の神隠し",
    year: 2001,
    overview:
      "A ten-year-old girl must work in a spirit world bathhouse to save her parents after they're transformed into pigs.",
    genres: [G.animation, G.fantasy],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.6,
    runtimeMinutes: 125,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("rumi-hiiragi", "Rumi Hiiragi", "Chihiro", 0),
      member("miyu-irino", "Miyu Irino", "Haku", 1),
      member("mari-natsuki", "Mari Natsuki", "Yubaba", 2),
    ],
    crew: [
      crewMember("hayao-miyazaki", "Hayao Miyazaki", "director"),
      crewMember("hayao-miyazaki", "Hayao Miyazaki", "writer"),
    ],
  },
  {
    id: "city-of-god",
    mediaType: "movie",
    name: "City of God",
    originalName: "Cidade de Deus",
    year: 2002,
    overview:
      "Two boys growing up in a Rio de Janeiro favela take opposite paths as gang violence consumes their neighborhood over two decades.",
    genres: [G.crime, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.6,
    runtimeMinutes: 130,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("alexandre-rodrigues", "Alexandre Rodrigues", "Rocket", 0),
      member("leandro-firmino", "Leandro Firmino", "Li'l Zé", 1),
      member("phellipe-haagensen", "Phellipe Haagensen", "Bené", 2),
    ],
    crew: [
      crewMember("fernando-meirelles", "Fernando Meirelles", "director"),
      crewMember("braulio-mantovani", "Bráulio Mantovani", "writer"),
    ],
  },
  {
    id: "mad-max-fury-road",
    mediaType: "movie",
    name: "Mad Max: Fury Road",
    originalName: null,
    year: 2015,
    overview:
      "A wasteland drifter joins a rebel imperator to smuggle a tyrant's captives across the desert in an extended, high-speed chase.",
    genres: [G.action, G.adventure],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.1,
    runtimeMinutes: 120,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("tom-hardy", "Tom Hardy", "Max Rockatansky", 0),
      member("charlize-theron", "Charlize Theron", "Imperator Furiosa", 1),
      member("nicholas-hoult", "Nicholas Hoult", "Nux", 2),
    ],
    crew: [
      crewMember("george-miller", "George Miller", "director"),
      crewMember("george-miller", "George Miller", "writer"),
      crewMember("brendan-mccarthy", "Brendan McCarthy", "writer"),
      crewMember("nick-lathouris", "Nick Lathouris", "writer"),
    ],
  },
  {
    id: "parasite",
    mediaType: "movie",
    name: "Parasite",
    originalName: "기생충",
    year: 2019,
    overview:
      "A poor family schemes its way into the household staff of a wealthy family, uncovering a secret buried beneath the house itself.",
    genres: [G.drama, G.thriller],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.5,
    runtimeMinutes: 132,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("song-kang-ho", "Song Kang-ho", "Kim Ki-taek", 0),
      member("lee-sun-kyun", "Lee Sun-kyun", "Park Dong-ik", 1),
      member("cho-yeo-jeong", "Cho Yeo-jeong", "Park Yeon-kyo", 2),
    ],
    crew: [
      crewMember("bong-joon-ho", "Bong Joon-ho", "director"),
      crewMember("bong-joon-ho", "Bong Joon-ho", "writer"),
      crewMember("han-jin-won", "Han Jin-won", "writer"),
    ],
  },
  {
    id: "everything-everywhere-all-at-once",
    mediaType: "movie",
    name: "Everything Everywhere All at Once",
    originalName: null,
    year: 2022,
    overview:
      "An overwhelmed laundromat owner discovers she must connect with parallel versions of herself to stop a multiversal threat.",
    genres: [G.sciFi, G.comedy],
    posterUrl: null,
    backdropUrl: null,
    rating: 7.8,
    runtimeMinutes: 140,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("michelle-yeoh", "Michelle Yeoh", "Evelyn Wang", 0),
      member("stephanie-hsu", "Stephanie Hsu", "Joy Wang", 1),
      member("ke-huy-quan", "Ke Huy Quan", "Waymond Wang", 2),
    ],
    crew: [
      crewMember("daniel-kwan", "Daniel Kwan", "director"),
      crewMember("daniel-scheinert", "Daniel Scheinert", "director"),
      crewMember("daniel-kwan", "Daniel Kwan", "writer"),
      crewMember("daniel-scheinert", "Daniel Scheinert", "writer"),
    ],
  },
  {
    id: "oppenheimer",
    mediaType: "movie",
    name: "Oppenheimer",
    originalName: null,
    year: 2023,
    overview:
      "The physicist who led the Manhattan Project grapples with the weapon he built and the political fallout that follows.",
    genres: [G.drama, G.history],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.3,
    runtimeMinutes: 180,
    seasonCount: null,
    episodeCount: null,
    status: RELEASED,
    cast: [
      member("cillian-murphy", "Cillian Murphy", "J. Robert Oppenheimer", 0),
      member("emily-blunt", "Emily Blunt", "Kitty Oppenheimer", 1),
      member("matt-damon", "Matt Damon", "Leslie Groves", 2),
      member("robert-downey-jr", "Robert Downey Jr.", "Lewis Strauss", 3),
    ],
    crew: [
      crewMember("christopher-nolan", "Christopher Nolan", "director"),
      crewMember("christopher-nolan", "Christopher Nolan", "writer"),
    ],
  },

  // --- TV shows ---------------------------------------------------------
  {
    id: "breaking-bad",
    mediaType: "tv",
    name: "Breaking Bad",
    originalName: null,
    year: 2008,
    overview:
      "A high school chemistry teacher turned methamphetamine manufacturer descends deeper into the criminal underworld to secure his family's future.",
    genres: [G.crime, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.5,
    runtimeMinutes: null,
    seasonCount: 5,
    episodeCount: 62,
    status: "ended",
    cast: [
      member("bryan-cranston", "Bryan Cranston", "Walter White", 0),
      member("aaron-paul", "Aaron Paul", "Jesse Pinkman", 1),
      member("anna-gunn", "Anna Gunn", "Skyler White", 2),
      member("dean-norris", "Dean Norris", "Hank Schrader", 3),
    ],
    crew: [crewMember("vince-gilligan", "Vince Gilligan", "creator")],
  },
  {
    id: "the-wire",
    mediaType: "tv",
    name: "The Wire",
    originalName: null,
    year: 2002,
    overview:
      "Baltimore police and the drug trade they investigate are shown through the lens of the institutions that fail both sides.",
    genres: [G.crime, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.3,
    runtimeMinutes: null,
    seasonCount: 5,
    episodeCount: 60,
    status: "ended",
    cast: [
      member("dominic-west", "Dominic West", "Jimmy McNulty", 0),
      member("lance-reddick", "Lance Reddick", "Cedric Daniels", 1),
      member("idris-elba", "Idris Elba", "Stringer Bell", 2),
      member("sonja-sohn", "Sonja Sohn", "Kima Greggs", 3),
    ],
    crew: [crewMember("david-simon", "David Simon", "creator")],
  },
  {
    id: "fleabag",
    mediaType: "tv",
    name: "Fleabag",
    originalName: null,
    year: 2016,
    overview:
      "A grieving, self-destructive woman in London breaks the fourth wall to confess exactly how badly she's handling everything.",
    genres: [G.comedy, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.7,
    runtimeMinutes: null,
    seasonCount: 2,
    episodeCount: 12,
    status: "ended",
    cast: [
      member("phoebe-waller-bridge", "Phoebe Waller-Bridge", "Fleabag", 0),
      member("sian-clifford", "Sian Clifford", "Claire", 1),
      member("andrew-scott", "Andrew Scott", "The Priest", 2),
    ],
    crew: [crewMember("phoebe-waller-bridge", "Phoebe Waller-Bridge", "creator")],
  },
  {
    id: "chernobyl",
    mediaType: "tv",
    name: "Chernobyl",
    originalName: null,
    year: 2019,
    overview:
      "Scientists and officials scramble to contain the fallout of a catastrophic nuclear reactor failure in the Soviet Union — and to keep the truth from disappearing with it.",
    genres: [G.drama, G.history],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.4,
    runtimeMinutes: null,
    seasonCount: 1,
    episodeCount: 5,
    status: "ended",
    cast: [
      member("jared-harris", "Jared Harris", "Valery Legasov", 0),
      member("stellan-skarsgard", "Stellan Skarsgård", "Boris Shcherbina", 1),
      member("emily-watson", "Emily Watson", "Ulana Khomyuk", 2),
    ],
    crew: [crewMember("craig-mazin", "Craig Mazin", "creator")],
  },
  {
    id: "stranger-things",
    mediaType: "tv",
    name: "Stranger Things",
    originalName: null,
    year: 2016,
    overview:
      "A small Indiana town is pulled into a parallel dimension after a boy vanishes and a girl with strange powers appears in his place.",
    genres: [G.sciFi, G.horror],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.6,
    runtimeMinutes: null,
    seasonCount: 4,
    episodeCount: 34,
    status: "returning",
    cast: [
      member("millie-bobby-brown", "Millie Bobby Brown", "Eleven", 0),
      member("finn-wolfhard", "Finn Wolfhard", "Mike Wheeler", 1),
      member("winona-ryder", "Winona Ryder", "Joyce Byers", 2),
      member("david-harbour", "David Harbour", "Jim Hopper", 3),
    ],
    crew: [
      crewMember("matt-duffer", "Matt Duffer", "creator"),
      crewMember("ross-duffer", "Ross Duffer", "creator"),
    ],
  },
  {
    id: "the-office-us",
    mediaType: "tv",
    name: "The Office",
    originalName: null,
    year: 2005,
    overview:
      "A documentary crew captures the daily absurdities of a mid-sized paper company's regional office in Scranton, Pennsylvania.",
    genres: [G.comedy],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.9,
    runtimeMinutes: null,
    seasonCount: 9,
    episodeCount: 201,
    status: "ended",
    cast: [
      member("steve-carell", "Steve Carell", "Michael Scott", 0),
      member("rainn-wilson", "Rainn Wilson", "Dwight Schrute", 1),
      member("john-krasinski", "John Krasinski", "Jim Halpert", 2),
      member("jenna-fischer", "Jenna Fischer", "Pam Beesly", 3),
    ],
    // "Developed by," in TMDB/US-broadcast terms — the US adaptation's
    // stable show-level creator credit, distinct from Gervais/Merchant's
    // original UK format.
    crew: [crewMember("greg-daniels", "Greg Daniels", "creator")],
  },
  {
    id: "greys-anatomy",
    mediaType: "tv",
    name: "Grey's Anatomy",
    originalName: null,
    year: 2005,
    overview:
      "Surgical interns at a Seattle teaching hospital navigate high-stakes operations and tangled relationships over years of residency.",
    genres: [G.drama, G.romance],
    posterUrl: null,
    backdropUrl: null,
    rating: 7.6,
    runtimeMinutes: null,
    seasonCount: 20,
    episodeCount: 431,
    status: "returning",
    cast: [
      member("ellen-pompeo", "Ellen Pompeo", "Meredith Grey", 0),
      member("sandra-oh", "Sandra Oh", "Cristina Yang", 1),
      member("chandra-wilson", "Chandra Wilson", "Miranda Bailey", 2),
    ],
    // Deliberately empty — the mock catalog's "no crew credited" case (real
    // shows sometimes have thin or unlisted crew data too), matching how
    // Grey's Anatomy already stands in as the "nothing special" control
    // elsewhere in this file.
    crew: [],
  },
  {
    id: "true-detective",
    mediaType: "tv",
    name: "True Detective",
    originalName: null,
    year: 2014,
    overview:
      "Each season follows a new set of investigators unraveling a disturbing case that reshapes how they see themselves.",
    genres: [G.crime, G.mystery],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.1,
    runtimeMinutes: null,
    // seasonCount/episodeCount/status deliberately diverge from the real show
    // (real S4 "Night Country" ran 6 episodes and the anthology's future is
    // genuinely undetermined) — this is the mock catalog's "ended mid-season,
    // no more episodes coming" test case: a final season shorter than every
    // season before it, with status flipped to "canceled" rather than
    // "returning". See episodes.ts for the full breakdown.
    seasonCount: 4,
    episodeCount: 14,
    status: "canceled",
    cast: [
      member("matthew-mcconaughey", "Matthew McConaughey", "Rust Cohle", 0),
      member("woody-harrelson", "Woody Harrelson", "Marty Hart", 1),
      member("jodie-foster", "Jodie Foster", "Liz Danvers", 2),
    ],
    crew: [crewMember("nic-pizzolatto", "Nic Pizzolatto", "creator")],
  },
  {
    id: "game-of-thrones",
    mediaType: "tv",
    name: "Game of Thrones",
    originalName: null,
    year: 2011,
    overview:
      "Noble houses across a divided continent scheme for control of an iron throne while an ancient threat gathers beyond the northern wall.",
    genres: [G.fantasy, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.2,
    runtimeMinutes: null,
    seasonCount: 8,
    episodeCount: 73,
    status: "ended",
    cast: [
      member("emilia-clarke", "Emilia Clarke", "Daenerys Targaryen", 0),
      member("kit-harington", "Kit Harington", "Jon Snow", 1),
      member("peter-dinklage", "Peter Dinklage", "Tyrion Lannister", 2),
      member("lena-headey", "Lena Headey", "Cersei Lannister", 3),
    ],
    crew: [
      crewMember("david-benioff", "David Benioff", "creator"),
      crewMember("d-b-weiss", "D.B. Weiss", "creator"),
    ],
  },
  {
    id: "the-bear",
    mediaType: "tv",
    name: "The Bear",
    originalName: null,
    year: 2022,
    overview:
      "A young chef returns home to run his late brother's struggling Chicago sandwich shop and turn it into something more.",
    genres: [G.comedy, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.6,
    runtimeMinutes: null,
    // Season 4 here is invented for this mock catalog — the real show's
    // actual future seasons aren't knowable or relevant to a local dev
    // fixture. It's the "currently airing, next episode date in the
    // future" test case: three aired episodes plus one dated after today.
    // See episodes.ts.
    seasonCount: 4,
    episodeCount: 13,
    status: "returning",
    cast: [
      member(
        "jeremy-allen-white",
        "Jeremy Allen White",
        'Carmen "Carmy" Berzatto',
        0,
      ),
      member("ayo-edebiri", "Ayo Edebiri", "Sydney Adamu", 1),
      member("ebon-moss-bachrach", "Ebon Moss-Bachrach", "Richie", 2),
    ],
    crew: [crewMember("christopher-storer", "Christopher Storer", "creator")],
  },
  {
    id: "avatar-the-last-airbender",
    mediaType: "tv",
    name: "Avatar: The Last Airbender",
    originalName: null,
    year: 2005,
    overview:
      "A young monk wakes from a century-long sleep to master the four elements and end a war before it consumes the world.",
    genres: [G.animation, G.fantasy],
    posterUrl: null,
    backdropUrl: null,
    rating: 9.3,
    runtimeMinutes: null,
    seasonCount: 3,
    episodeCount: 61,
    status: "ended",
    cast: [
      member("zach-tyler-eisen", "Zach Tyler Eisen", "Aang", 0),
      member("mae-whitman", "Mae Whitman", "Katara", 1),
      member("jack-desena", "Jack DeSena", "Sokka", 2),
    ],
    crew: [
      crewMember("michael-dante-dimartino", "Michael Dante DiMartino", "creator"),
      crewMember("bryan-konietzko", "Bryan Konietzko", "creator"),
    ],
  },
  {
    id: "twin-peaks",
    mediaType: "tv",
    name: "Twin Peaks",
    originalName: null,
    year: 1990,
    overview:
      "An FBI agent's investigation into the murder of a small-town homecoming queen uncovers the strange forces hiding beneath Twin Peaks.",
    genres: [G.mystery, G.drama],
    posterUrl: null,
    backdropUrl: null,
    rating: 8.8,
    runtimeMinutes: null,
    // episodeCount covers only the two numbered seasons — a Season 0
    // "Specials" also exists in episodes.ts (2 bonus episodes) and is
    // deliberately excluded from this total, matching how TMDB itself
    // usually keeps `number_of_episodes` scoped to numbered seasons.
    seasonCount: 2,
    episodeCount: 9,
    status: "ended",
    cast: [
      member("kyle-maclachlan", "Kyle MacLachlan", "Dale Cooper", 0),
      member(
        "sheryl-lee",
        "Sheryl Lee",
        "Laura Palmer / Maddy Ferguson",
        1,
      ),
      member("michael-ontkean", "Michael Ontkean", "Harry Truman", 2),
    ],
    crew: [
      crewMember("david-lynch", "David Lynch", "creator"),
      crewMember("mark-frost", "Mark Frost", "creator"),
    ],
  },
];
